#!/usr/bin/env node

/**
 * Model freshness checker — Phase 2 of D-235.
 *
 * Detects when Anthropic ships a model newer than what src/models.ts pins
 * and signals the GitHub Actions workflow to open a one-line bump PR for
 * human review. Detection is automatic; adoption is NEVER automatic.
 *
 * Pure logic functions are exported so the vitest unit tests can import
 * them without any network / filesystem / gh CLI side-effects.
 */

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// ─── Pure functions (exported for testing) ───────────────────────────

/** Families the script knows how to track. */
export const KNOWN_FAMILIES = ["opus", "sonnet", "haiku"];

/**
 * Parse a model identifier into { family, version: [major, minor] }.
 *
 * Handles four naming conventions:
 *   "opus-4-8"                      → recommendation pin (short form)
 *   "claude-opus-4-7"               → API / synthesis id
 *   "claude-3-5-sonnet-20241022"    → legacy date-suffixed
 *   "claude-3-opus-20240229"        → legacy major-only date-suffixed
 *
 * Returns null for unrecognised identifiers.
 *
 * @param {string} id
 * @returns {{ family: string, version: [number, number] } | null}
 */
export function parseModelIdentifier(id) {
  if (!id || typeof id !== "string") return null;
  const stripped = id.replace(/^claude-/, "");

  // Newer: {family}-{major}-{minor}  (1-2 digit minor excludes YYYYMMDD dates)
  for (const family of KNOWN_FAMILIES) {
    const m = stripped.match(new RegExp(`^${family}-(\\d+)-(\\d{1,2})(?:$|\\D)`));
    if (m) return { family, version: [parseInt(m[1], 10), parseInt(m[2], 10)] };
  }

  // Newer without minor: {family}-{major}
  for (const family of KNOWN_FAMILIES) {
    const m = stripped.match(new RegExp(`^${family}-(\\d+)(?:$|\\D)`));
    if (m) return { family, version: [parseInt(m[1], 10), 0] };
  }

  // Legacy: {major}-{minor}-{family}  (e.g. 3-5-sonnet-20241022)
  for (const family of KNOWN_FAMILIES) {
    const m = stripped.match(
      new RegExp(`^(\\d+)-(\\d{1,2})-${family}(?:$|\\D)`),
    );
    if (m) return { family, version: [parseInt(m[1], 10), parseInt(m[2], 10)] };
  }

  // Legacy major-only: {major}-{family}  (e.g. 3-opus-20240229)
  for (const family of KNOWN_FAMILIES) {
    const m = stripped.match(new RegExp(`^(\\d+)-${family}(?:$|\\D)`));
    if (m) return { family, version: [parseInt(m[1], 10), 0] };
  }

  return null;
}

/**
 * From a list of API models, return the newest one in `family` by version
 * tuple (major, then minor; `created_at` as tiebreak only).
 *
 * @param {Array<{id: string, display_name: string, created_at: string}>} models
 * @param {string} family
 * @returns {object | null}
 */
export function findNewestInFamily(models, family) {
  const candidates = [];
  for (const model of models) {
    const parsed = parseModelIdentifier(model.id);
    if (parsed && parsed.family === family) {
      candidates.push({ ...model, _parsed: parsed });
    }
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const [aMaj, aMin] = a._parsed.version;
    const [bMaj, bMin] = b._parsed.version;
    if (aMaj !== bMaj) return bMaj - aMaj;
    if (aMin !== bMin) return bMin - aMin;
    return (
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  });

  return candidates[0];
}

/**
 * True when `newestVersion` is strictly newer than `pinVersion`.
 *
 * @param {[number, number]} pinVersion
 * @param {[number, number]} newestVersion
 * @returns {boolean}
 */
export function isPinStale(pinVersion, newestVersion) {
  const [pinMaj, pinMin] = pinVersion;
  const [newMaj, newMin] = newestVersion;
  if (newMaj > pinMaj) return true;
  if (newMaj === pinMaj && newMin > pinMin) return true;
  return false;
}

/**
 * Regex-extract current pins from the text of src/models.ts.
 *
 * @param {string} fileContent
 * @returns {{ recommendations: Array<{category: string, code: string, display: string}>, synthesisId: string | null }}
 */
export function extractPins(fileContent) {
  const recommendations = [];
  const recBlock = fileContent.match(
    /RECOMMENDATION_MODELS\s*=\s*\{([\s\S]*?)\}\s*as\s*const/,
  );
  if (recBlock) {
    const entries = [
      ...recBlock[1].matchAll(
        /(\w+):\s*\{\s*code:\s*"([^"]+)",\s*display:\s*"([^"]+)"\s*\}/g,
      ),
    ];
    for (const [, category, code, display] of entries) {
      recommendations.push({ category, code, display });
    }
  }

  const synthMatch = fileContent.match(/SYNTHESIS_MODEL_ID\s*=\s*"([^"]+)"/);
  const synthesisId = synthMatch ? synthMatch[1] : null;

  return { recommendations, synthesisId };
}

// ─── I/O helpers (not tested) ────────────────────────────────────────

/**
 * Paginate the Anthropic Models API.
 * @param {string} apiKey
 * @returns {Promise<{models?: object[], error?: string}>}
 */
async function fetchAllModels(apiKey) {
  const all = [];
  let url = "https://api.anthropic.com/v1/models?limit=1000";

  while (url) {
    const res = await fetch(url, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      return {
        error: `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
      };
    }

    const body = await res.json();
    if (body.data) all.push(...body.data);

    if (body.has_more && body.last_id) {
      url = `https://api.anthropic.com/v1/models?limit=1000&after_id=${body.last_id}`;
    } else {
      url = null;
    }
  }

  return { models: all };
}

/** Write a key-value pair to $GITHUB_OUTPUT (no-op outside Actions). */
function setGitHubOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  if (value.includes("\n")) {
    const delim = `ghadelim_${Date.now()}`;
    appendFileSync(file, `${name}<<${delim}\n${value}\n${delim}\n`);
  } else {
    appendFileSync(file, `${name}=${value}\n`);
  }
}

/** Run a gh CLI command; return stdout or empty string on failure. */
function ghExec(cmd) {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

/** Build the short model code from family + version. */
function buildCode(family, version) {
  const [major, minor] = version;
  return minor > 0 ? `${family}-${major}-${minor}` : `${family}-${major}`;
}

/** Build human-readable display name from family + version. */
function buildDisplay(family, version) {
  const [major, minor] = version;
  const cap = family.charAt(0).toUpperCase() + family.slice(1);
  return minor > 0 ? `${cap} ${major}.${minor}` : `${cap} ${major}`;
}

/** Build full API-style synthesis id from family + version. */
function buildSynthId(family, version) {
  const [major, minor] = version;
  return minor > 0
    ? `claude-${family}-${major}-${minor}`
    : `claude-${family}-${major}`;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const modelsPath = resolve(rootDir, "src/models.ts");

  // 1. Read current pins
  const fileContent = readFileSync(modelsPath, "utf-8");
  const pins = extractPins(fileContent);

  const allPinCodes = [
    ...pins.recommendations.map((r) => r.code),
    ...(pins.synthesisId ? [pins.synthesisId] : []),
  ];

  // 2. Validate every pin resolves to a known family
  const unrecognized = allPinCodes.filter((c) => !parseModelIdentifier(c));
  if (unrecognized.length > 0) {
    const title = "model-freshness: unrecognized model family / API change";
    const body = [
      "The model-freshness script could not parse these pinned identifiers:",
      "",
      ...unrecognized.map((c) => `- \`${c}\``),
      "",
      "This likely means the naming convention changed. Manual investigation required.",
    ].join("\n");
    ghExec(
      `gh issue create --title "${title}" --body ${JSON.stringify(body)}`,
    );
    console.log("Unrecognized pins:", unrecognized.join(", "));
    setGitHubOutput("has_bumps", "false");
    return;
  }

  // 3. Fetch all models from the Anthropic API
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set");
    process.exit(1);
  }

  const result = await fetchAllModels(apiKey);
  if (result.error) {
    const title = "model-freshness: unrecognized model family / API change";
    ghExec(
      `gh issue create --title "${title}" --body ${JSON.stringify(`Anthropic Models API error:\\n\\n${result.error}\\n\\nManual investigation required.`)}`,
    );
    console.log("API error:", result.error);
    setGitHubOutput("has_bumps", "false");
    return;
  }

  const models = result.models;

  // 4. Find the newest model in each family we pin
  const pinnedFamilies = new Set(
    allPinCodes.map((c) => parseModelIdentifier(c).family),
  );
  const newestByFamily = {};
  for (const family of pinnedFamilies) {
    newestByFamily[family] = findNewestInFamily(models, family);
  }

  // 5. Detect stale recommendation pins (deduplicated per family)
  const recBumps = [];
  const seenRecFamilies = new Set();
  for (const rec of pins.recommendations) {
    const parsed = parseModelIdentifier(rec.code);
    if (seenRecFamilies.has(parsed.family)) continue;
    const newest = newestByFamily[parsed.family];
    if (newest && isPinStale(parsed.version, newest._parsed.version)) {
      recBumps.push({
        family: parsed.family,
        currentCode: rec.code,
        currentDisplay: rec.display,
        currentVersion: parsed.version,
        newVersion: newest._parsed.version,
      });
      seenRecFamilies.add(parsed.family);
    }
  }

  // 6. Detect stale synthesis pin (evaluated separately)
  let synthBump = null;
  if (pins.synthesisId) {
    const parsed = parseModelIdentifier(pins.synthesisId);
    const newest = newestByFamily[parsed.family];
    if (newest && isPinStale(parsed.version, newest._parsed.version)) {
      synthBump = {
        family: parsed.family,
        currentId: pins.synthesisId,
        currentVersion: parsed.version,
        newVersion: newest._parsed.version,
      };
    }
  }

  if (recBumps.length === 0 && !synthBump) {
    console.log("All model pins are up to date.");
    setGitHubOutput("has_bumps", "false");
    return;
  }

  // 7. Idempotency — skip if an open PR already targets these exact bumps
  const allBumps = [...recBumps, ...(synthBump ? [synthBump] : [])];
  const openPRsJson = ghExec(
    "gh pr list --label model-bump --state open --json body --limit 100",
  );
  if (openPRsJson) {
    try {
      const prs = JSON.parse(openPRsJson);
      for (const pr of prs) {
        const prBody = pr.body || "";
        const allAlreadyProposed = allBumps.every((b) =>
          prBody.includes(buildCode(b.family, b.newVersion)),
        );
        if (allAlreadyProposed) {
          console.log("PR already open with these bumps.");
          setGitHubOutput("has_bumps", "false");
          return;
        }
      }
    } catch {
      /* best-effort idempotency */
    }
  }

  // 8. Apply bumps to src/models.ts (string-replace only affected values)
  let updated = fileContent;

  for (const bump of recBumps) {
    const newCode = buildCode(bump.family, bump.newVersion);
    const newDisplay = buildDisplay(bump.family, bump.newVersion);
    updated = updated.replaceAll(
      `code: "${bump.currentCode}"`,
      `code: "${newCode}"`,
    );
    updated = updated.replaceAll(
      `display: "${bump.currentDisplay}"`,
      `display: "${newDisplay}"`,
    );
  }

  if (synthBump) {
    const newSynthId = buildSynthId(synthBump.family, synthBump.newVersion);
    updated = updated.replace(
      `SYNTHESIS_MODEL_ID = "${synthBump.currentId}"`,
      `SYNTHESIS_MODEL_ID = "${newSynthId}"`,
    );
  }

  writeFileSync(modelsPath, updated, "utf-8");
  console.log("Updated src/models.ts with new model pins.");

  // 9. Build PR body and write to temp file for the workflow
  const bodyLines = ["## Model Pin Bumps\n"];

  if (recBumps.length > 0) {
    bodyLines.push("### Recommendation Models\n");
    bodyLines.push(
      "> **Note:** The Models API is NOT the claude.ai app model picker. A human must confirm the model is selectable in the app before merging a recommendation bump.\n",
    );
    for (const bump of recBumps) {
      const newCode = buildCode(bump.family, bump.newVersion);
      bodyLines.push(
        `- **${bump.family}**: \`${bump.currentCode}\` \u2192 \`${newCode}\``,
      );
    }
    bodyLines.push("");
  }

  if (synthBump) {
    const newSynthId = buildSynthId(synthBump.family, synthBump.newVersion);
    bodyLines.push(
      "### \u26a0\ufe0f Synthesis model \u2014 human review required (INS-244 / INS-245)\n",
    );
    bodyLines.push(
      `- **${synthBump.family}**: \`${synthBump.currentId}\` \u2192 \`${newSynthId}\``,
    );
    bodyLines.push("");
  }

  const prBody = bodyLines.join("\n");
  writeFileSync("/tmp/model-bump-body.md", prBody, "utf-8");

  // 10. Signal the workflow
  setGitHubOutput("has_bumps", "true");

  const summary = allBumps
    .map(
      (b) =>
        `${b.family} ${b.currentVersion.join(".")}\u2192${b.newVersion.join(".")}`,
    )
    .join(", ");
  console.log("Bumps detected:", summary);
}

// ─── Entry point ─────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
if (
  process.argv[1] === __filename ||
  resolve(process.argv[1] || "") === __filename
) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
}
