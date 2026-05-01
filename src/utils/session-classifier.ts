/**
 * Session classifier (brief-405 / D-191) — recommends a model + thinking
 * setting for the next PRISM session based on a deterministic keyword score
 * over the upcoming work bundle.
 *
 * Surfaced in two places:
 *  - prism_finalize banner (primary, pre-boot signal)
 *  - prism_bootstrap response (secondary, safety net)
 *
 * The recommendation is advisory — the operator overrides via the model
 * selector at session start. Goal is to avoid the wasted-boot scenario
 * where a session opens on Opus 4.7 + Adaptive on for what turns out to
 * be 30 turns of mechanical work.
 */

export type RecommendedModel = "opus-4-7" | "sonnet-4-6" | "haiku-4-5";
export type RecommendedThinking = "adaptive-on" | "adaptive-off";
export type SessionCategory = "reasoning_heavy" | "executional" | "mixed";

export interface SessionRecommendation {
  category: SessionCategory;
  model: RecommendedModel;
  thinking: RecommendedThinking;
  rationale: string;
  display: string;
  scores: {
    reasoning_heavy: number;
    executional: number;
  };
}

export interface ClassifySessionInput {
  next_steps: string[];
  // critical_context and opening_message removed (brief-415 / F7) — D-193
  // Piece 1 made both inputs unreachable from finalize and bootstrap.
  // Restoring them would re-introduce the S107→S108 banner-discrepancy
  // class of bug (finalize and bootstrap classifying the same handoff with
  // divergent input bundles). Future readers should hit a compile error if
  // they try to add them back.
}

/**
 * Reasoning-heavy keyword triggers. Hits indicate design / multi-doc
 * investigation / judgment work that benefits from Opus + adaptive thinking.
 *
 * Two lists per bucket (brief-415 / F1):
 *  - WHOLE_WORD: matched via `\bkw\b` regex — used for short keywords where
 *    prefix-match would over-fire (e.g. "log" must not match "login").
 *  - PREFIX: matched via `\bkw[a-z]*\b` — catches noun/gerund/adjective
 *    derivatives without listing each one separately. Example: "verif"
 *    matches "verify", "verifies", "verification", "verifying", "verified".
 *
 * Multi-word phrases (REASONING_PHRASES) are matched as substrings BEFORE
 * the per-word tokenization runs so they don't get clipped by
 * punctuation/whitespace boundaries.
 */
const REASONING_WHOLE_WORD = [
  "brainstorm",
  "tradeoff",
  "strategy",
] as const;

const REASONING_PREFIX = [
  "architect",   // catches architect, architecture, architectural
  "investigat",  // catches investigate, investigation, investigating
  "debug",       // catches debug, debugging, debugger
  "evaluat",     // catches evaluate, evaluation, evaluating
  "analyz",      // catches analyze, analyzing (US verb forms — drops the trailing 'e')
  "analys",      // catches analysis, analyses, analyse, analysing (noun form +
                 //   Brit verb spelling) — sibling spelling that prefix-match
                 //   on `analyz` cannot reach (s vs z), which the F1 audit
                 //   intent requires us to catch.
  "propos",      // catches propose, proposal, proposing
  "compar",      // catches compare, comparison, comparing
  "design",      // catches design, designing — whole-word safe per audit data
                 //   ("designate" does not appear in PRISM next_steps)
  "scope",       // F3 — catches scope, scoping, rescoping
  "diagnos",     // F3 — catches diagnose, diagnosis, diagnosing, diagnostic
] as const;

const REASONING_PHRASES = [
  "decide whether",
  // "follow-up on" removed S109 / brief-415 (F6) — audit showed roughly
  // even split between reasoning and executional connotations; removed to
  // stop adding noise without consistent signal.
] as const;

/**
 * Executional keyword triggers. Hits indicate mechanical cleanup / patches /
 * deterministic application work that's well within Sonnet's range and does
 * not need adaptive thinking overhead.
 */
const EXECUTIONAL_WHOLE_WORD = [
  "log",       // whole-word: must not fire on "login", "logging", "logical"
  "sync",
  "bump",
  "pin",       // F5
  "wire",      // F5
] as const;

const EXECUTIONAL_PREFIX = [
  "cleanup",
  "renam",      // catches rename, renaming
  "patch",
  "push",
  "backfill",
  "appl",       // catches apply, applies, applying, application — accepted:
                //   PRISM next_steps that mention "application" overwhelmingly
                //   refer to applying a change, not "applications" as a noun.
  "verif",      // F4 — catches verify, verifies, verification, verifying, verified
  "demot",      // catches demote, demotion, demoting
  "consolidat", // catches consolidate, consolidation, consolidating
  "updat",      // catches update, updates, updating
  "enroll",     // catches enroll, enrolling, enrollment
  "dispatch",   // F5 — catches dispatch, dispatching, dispatched
  "merg",       // F5 — catches merge, merging, merged, merger
  "delet",      // F5 — catches delete, deleting, deletion
  "redeploy",   // F5
  "migrat",     // F5 — catches migrate, migration, migrating
  "clos",       // F5 — catches close, closing, closure (also "clothes" / "closet"
                //   in theory — neither appears in PRISM next_steps)
] as const;

const EXECUTIONAL_PHRASES = [
  "re-tier",
] as const;

/**
 * Conditional keywords — only count when paired with a qualifier in the
 * same item. Prevents false positives on common words ("audit" in
 * "audit log file" is not the same as "audit report" or "audit findings").
 *
 * The `audit` qualifier list expanded S109 / brief-415 (F2) to reach the
 * meta-work cases that prompted the calibration ("audit the keyword lists",
 * "audit Tier A standing rules", "audit code paths"). The qualifier check
 * uses `lower.includes(q)` against the whole item, gated on the
 * whole-word `\baudit\b` match — so qualifier substrings don't need
 * word-boundary precision.
 */
interface ConditionalKeyword {
  keyword: string;
  requiresAny: string[];
  bucket: "reasoning" | "executional";
}

const CONDITIONAL_KEYWORDS: ConditionalKeyword[] = [
  {
    keyword: "audit",
    requiresAny: [
      "report", "findings",                                 // existing — documentation-style
      "list", "lists", "rules", "keywords",                 // F2 — meta-work qualifiers
      "code", "system", "behavior", "session", "sessions",  // F2 — investigation qualifiers
    ],
    bucket: "reasoning",
  },
  { keyword: "archive", requiresAny: ["content", "session", "insights", "log"], bucket: "executional" },
  { keyword: "restart", requiresAny: ["daemon", "trigger", "service"], bucket: "executional" },
];

/**
 * Count keyword/phrase hits within a single text item.
 * Each occurrence of every distinct keyword/phrase counts. Case-insensitive.
 *
 * Phrases are matched as substrings; whole-word keywords use word-boundary
 * regex (so "log" doesn't fire on "logging"); prefix keywords match the
 * prefix followed by zero+ trailing letters then a word boundary (so
 * "verif" matches "verify", "verifies", "verification").
 */
function countHits(
  text: string,
  wholeWord: ReadonlyArray<string>,
  prefix: ReadonlyArray<string>,
  phrases: ReadonlyArray<string>,
): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let hits = 0;

  for (const phrase of phrases) {
    let idx = 0;
    while ((idx = lower.indexOf(phrase, idx)) !== -1) {
      hits++;
      idx += phrase.length;
    }
  }

  for (const kw of wholeWord) {
    const re = new RegExp(`\\b${escapeForRegex(kw)}\\b`, "g");
    const matches = lower.match(re);
    if (matches) hits += matches.length;
  }

  for (const kw of prefix) {
    // \b{prefix}[a-z]*\b — prefix followed by zero+ letters then a word
    // boundary. Catches noun/gerund/adjective derivatives without listing
    // each one as a separate keyword.
    const re = new RegExp(`\\b${escapeForRegex(kw)}[a-z]*\\b`, "g");
    const matches = lower.match(re);
    if (matches) hits += matches.length;
  }

  return hits;
}

function countConditionalHits(text: string, bucket: "reasoning" | "executional"): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let hits = 0;

  for (const cond of CONDITIONAL_KEYWORDS) {
    if (cond.bucket !== bucket) continue;
    const kwRe = new RegExp(`\\b${escapeForRegex(cond.keyword)}\\b`, "g");
    const matches = lower.match(kwRe);
    if (!matches) continue;
    const hasQualifier = cond.requiresAny.some((q) => lower.includes(q.toLowerCase()));
    if (hasQualifier) hits += matches.length;
  }

  return hits;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Score a single text item against both buckets.
 */
function scoreItem(text: string): { reasoning: number; executional: number } {
  const reasoning =
    countHits(text, REASONING_WHOLE_WORD, REASONING_PREFIX, REASONING_PHRASES) +
    countConditionalHits(text, "reasoning");
  const executional =
    countHits(text, EXECUTIONAL_WHOLE_WORD, EXECUTIONAL_PREFIX, EXECUTIONAL_PHRASES) +
    countConditionalHits(text, "executional");
  return { reasoning, executional };
}

/**
 * Format the rationale string for the recommendation.
 * Capped at 80 chars to fit in the banner code fence.
 */
function buildRationale(category: SessionCategory): string {
  const RATIONALES: Record<SessionCategory, string> = {
    reasoning_heavy: "Queue includes design / multi-doc investigation",
    executional: "Queue is mechanical cleanup / patches",
    mixed: "Mixed queue — execution with some judgment",
  };
  const text = RATIONALES[category];
  return text.length > 80 ? text.slice(0, 77) + "..." : text;
}

const DISPLAY_BY_CATEGORY: Record<SessionCategory, string> = {
  reasoning_heavy: "Opus 4.7 · Adaptive on",
  executional: "Sonnet 4.6 · Adaptive off",
  mixed: "Opus 4.7 · Adaptive off",
};

const MODEL_BY_CATEGORY: Record<SessionCategory, RecommendedModel> = {
  reasoning_heavy: "opus-4-7",
  executional: "sonnet-4-6",
  mixed: "opus-4-7",
};

const THINKING_BY_CATEGORY: Record<SessionCategory, RecommendedThinking> = {
  reasoning_heavy: "adaptive-on",
  executional: "adaptive-off",
  mixed: "adaptive-off",
};

/**
 * Classify the next session and produce a recommended model + thinking
 * setting. Pure function — no I/O.
 *
 * Decision rule:
 *   ratio = reasoning_heavy_score / max(executional_score, 1)
 *   ratio >= 1.5  → reasoning_heavy → Opus 4.7 + Adaptive on
 *   ratio <= 0.67 → executional     → Sonnet 4.6 + Adaptive off
 *   otherwise     → mixed           → Opus 4.7 + Adaptive off (strong default)
 *
 * Empty input yields the mixed verdict — safe default that matches the
 * pre-classifier behavior of running Opus + Adaptive off.
 */
export function classifySession(input: ClassifySessionInput): SessionRecommendation {
  let reasoningScore = 0;
  let executionalScore = 0;

  for (const step of input.next_steps ?? []) {
    const s = scoreItem(step);
    reasoningScore += s.reasoning;
    executionalScore += s.executional;
  }

  // critical_context loop and opening_message 2x-weight block removed
  // S109 / brief-415 (F7) — D-193 Piece 1 made both inputs unreachable
  // from finalize and bootstrap, so the code paths were dead. Restoring
  // them would re-introduce the S107→S108 banner-discrepancy class of bug.

  const ratio = reasoningScore / Math.max(executionalScore, 1);

  let category: SessionCategory;
  if (reasoningScore === 0 && executionalScore === 0) {
    category = "mixed";
  } else if (ratio >= 1.5) {
    category = "reasoning_heavy";
  } else if (ratio <= 0.67) {
    category = "executional";
  } else {
    category = "mixed";
  }

  return {
    category,
    model: MODEL_BY_CATEGORY[category],
    thinking: THINKING_BY_CATEGORY[category],
    rationale: buildRationale(category),
    display: DISPLAY_BY_CATEGORY[category],
    scores: {
      reasoning_heavy: reasoningScore,
      executional: executionalScore,
    },
  };
}

/**
 * Render the persisted-recommendation markdown block (brief-411 / D-193 Piece 1).
 *
 * The block is written into handoff.md by `prism_finalize` and read back by
 * `prism_bootstrap` so the two tools agree on the same recommendation rather
 * than reclassifying with divergent inputs (pre-411, finalize used
 * `next_steps` only and bootstrap used next_steps + critical_context +
 * opening_message — same handoff yielded different verdicts).
 */
function renderRecommendationBlock(rec: SessionRecommendation): string {
  const [modelDisplay, thinkingDisplay] = rec.display.split(" · ");
  return [
    "## Recommended Session Settings",
    "",
    "<!-- prism:recommended_session_settings -->",
    `- Model: ${modelDisplay}`,
    `- Thinking: ${thinkingDisplay}`,
    `- Category: ${rec.category}`,
    `- Rationale: ${rec.rationale}`,
    "<!-- /prism:recommended_session_settings -->",
  ].join("\n");
}

/**
 * Inject the persisted-recommendation block into handoff.md content
 * (brief-411 A.1). Inserts immediately after the `## Meta` section and
 * before whatever follows. If the block already exists in the inbound
 * content (operator-edited handoff or re-finalize), it is replaced in
 * place. Returns the mutated string, or `null` if the handoff has no
 * `## Meta` section to anchor placement against (legacy projects —
 * caller logs a warning and proceeds without injection per the brief).
 *
 * Pure function — no I/O. Idempotent: calling twice with the same
 * recommendation yields the same output.
 */
export function injectPersistedRecommendation(
  handoffContent: string,
  recommendation: SessionRecommendation,
): string | null {
  if (!/^## Meta\s*$/m.test(handoffContent)) return null;

  // Strip any existing block so re-finalize (or operator-edited handoffs
  // with a stale block) gets a clean replacement rather than a duplicate.
  const existingBlockRe = /\n*## Recommended Session Settings\s*\n+<!-- prism:recommended_session_settings -->[\s\S]*?<!-- \/prism:recommended_session_settings -->\n*/;
  const cleaned = handoffContent.replace(existingBlockRe, "\n\n");

  // Capture the Meta section: from `## Meta` line through the body up to
  // (and excluding) the next `## ` header or EOF sentinel. The negative
  // lookahead is what bounds the section without depending on a specific
  // following section name.
  const metaSectionRe = /(^## Meta\s*\n(?:(?!^## |^<!--\s*EOF:).*\n?)*)/m;
  const m = metaSectionRe.exec(cleaned);
  if (!m || m.index === undefined) return null;

  const metaSection = m[1];
  const block = renderRecommendationBlock(recommendation);
  const trimmedMeta = metaSection.replace(/\n+$/, "");
  const replacement = `${trimmedMeta}\n\n${block}\n\n`;

  return cleaned.slice(0, m.index) + replacement + cleaned.slice(m.index + metaSection.length);
}

/**
 * Parse the persisted recommendation block from handoff.md content
 * (brief-411 A.2). Returns the SessionRecommendation reconstructed from
 * the block, or `null` if the block is absent, malformed, or carries an
 * invalid category value.
 *
 * Per brief-411: do not parse free-form display strings — the canonical
 * model + thinking enum values come from the `category` field via the
 * existing mapping tables. The display string is reconstructed from the
 * parsed Model + Thinking text fields for human-visible labels only.
 *
 * Scores are not preserved across persistence — they are informational
 * only and would be misleading if stored as a snapshot. Both fields are
 * returned as 0.
 */
export function parsePersistedRecommendation(
  handoffContent: string,
): SessionRecommendation | null {
  const match = handoffContent.match(
    /<!-- prism:recommended_session_settings -->([\s\S]*?)<!-- \/prism:recommended_session_settings -->/,
  );
  if (!match) return null;

  const body = match[1];
  // Tolerate variable whitespace after the bullet — operators may hand-edit
  // and YAML-style formatters sometimes pad colons. Field names and the
  // colon are still required.
  const modelDisplay = body.match(/^-\s+Model:\s*(.+)$/m)?.[1]?.trim();
  const thinkingDisplay = body.match(/^-\s+Thinking:\s*(.+)$/m)?.[1]?.trim();
  const category = body.match(/^-\s+Category:\s*(\w+)$/m)?.[1]?.trim();
  const rationale = body.match(/^-\s+Rationale:\s*(.+)$/m)?.[1]?.trim();

  if (!modelDisplay || !thinkingDisplay || !category || !rationale) return null;
  if (!["reasoning_heavy", "executional", "mixed"].includes(category)) return null;

  const cat = category as SessionCategory;
  return {
    category: cat,
    model: MODEL_BY_CATEGORY[cat],
    thinking: THINKING_BY_CATEGORY[cat],
    rationale,
    display: `${modelDisplay} · ${thinkingDisplay}`,
    scores: { reasoning_heavy: 0, executional: 0 },
  };
}
