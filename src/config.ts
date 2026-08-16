/**
 * PRISM MCP Server configuration — loaded from environment variables.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CC_DISPATCH_MODEL_ID, SYNTHESIS_MODEL_ID } from "./models.js";

// Load .env in local development (no-op if vars already set, e.g. Railway)
try {
  const envPath = resolve(process.cwd(), ".env");
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // .env not found — env vars come from Railway or are pre-set
}

/** GitHub Personal Access Token */
export const GITHUB_PAT = process.env.GITHUB_PAT ?? "";

/** GitHub repo owner */
export const GITHUB_OWNER = process.env.GITHUB_OWNER ?? "brdonath1";

/** PRISM framework repo name */
export const FRAMEWORK_REPO = process.env.FRAMEWORK_REPO ?? "prism-framework";

/** Path to the compressed MCP-mode behavioral rules template (D-31) */
export const MCP_TEMPLATE_PATH = "_templates/core-template-mcp.md";

/** HTTP port */
export const PORT = parseInt(process.env.PORT ?? "3000", 10);

/** Log level */
export const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

/** Server version. Keep this in lockstep with package.json `version`; bump on
 *  substantive src/** releases so health/status can identify the deployed
 *  runtime. 4.10.0 adds the production prism_x_sentiment tool; 4.11.0 adds the
 *  six Railway provisioning/lifecycle tools (create project/service/volume/
 *  domain, update service settings, delete service); 4.12.0 adds the D-275
 *  openrouter (GLM-5.2) mechanical-tier synthesis routing, per-invocation
 *  LLM_CALL cost telemetry, and the LLM_ROUTING_TABLE startup log; 4.13.0 is
 *  the S202 boot-lean server bundle (session_state_manifest + BOOT_INDEX_MODE,
 *  rules_hint, brief digest-dedup, PREFETCH_MODE, handoff item budget,
 *  masthead knob, kernel handshake, finalize compose-offload, synthesis size
 *  contracts + trim annotation); 4.13.1 is the S208 PR-S1 finalize+banner
 *  reliability bundle (banner fields on every bootstrap/finalize exit,
 *  network-safe finalization banner, bounded audit paths, measured boot doc
 *  count, render-failure diagnostics, FINALIZE_BANNER knob); 4.13.2 is the
 *  S208 PR-S2a boot+load latency bundle (sha/ETag-conditional rule-source
 *  cache, sha-keyed parse cache, prism_load_rules deadline, wave-3 hoist,
 *  boot-test path cache, bounded Railway observation race, total-elapsed
 *  retry budget, KI-28 doc-guard paths, archive body resolution) -- delivered
 *  bootstrap payload bytes are UNCHANGED by that release; 4.14.0 is the S208
 *  PR-S3 gated auth-hardening + ops truth-up release (the default-OFF
 *  AUTH_REQUIRE_BEARER knob, its pinned middleware tests, and the backfilled
 *  4.13.0 CHANGELOG entry) -- request handling is byte-identical to 4.13.2
 *  until an operator sets the knob; 4.14.1 is the S208 PR-S2b payload
 *  contract (single masthead via BOOT_MASTHEAD, compacted
 *  session_state_manifest.rules) -- the one release in the S208 server chain
 *  that deliberately CHANGES delivered bootstrap bytes, by design and by
 *  measurement (-6,328 B per boot on the prism corpus: 103,690 -> 97,362). */
export const SERVER_VERSION = "4.14.1";

/** MCP client timeout is ~60s. All server-side operations must complete within 50s
 *  to leave 10s buffer for transport overhead. This constrains synthesis, draft,
 *  and any long-running operations. */
export const MCP_SAFE_TIMEOUT = 50_000;

/** Default context window (tokens) for the server-side boot estimate.
 *  500K is the conservative fallback for Opus 4.8/4.7/4.6 chat sessions.
 *  Sonnet 5 is 1M on API / supported Claude Code surfaces, but the true
 *  Claude.ai chat window is resolved client-side per core-template Rule 9
 *  because the server cannot know the operator's active model selector.
 *  This default only feeds the boot-cost percentage in the banner. The prior
 *  200K default overstated
 *  boot cost ~2.5× against the real budget (brief-433 / D-240 Phase B R7-a).
 *  Env-overridable for per-deployment tuning without code change. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS =
  Number(process.env.DEFAULT_CONTEXT_WINDOW_TOKENS ?? 500_000) || 500_000;

/**
 * brief-s5 §4: was the context window EXPLICITLY overridden by env, and to
 * what? Returns null when the var is unset or unparseable — i.e. when the
 * value in play is the code default rather than an operator decision.
 *
 * DEFAULT_CONTEXT_WINDOW_TOKENS above cannot answer this: it collapses "the
 * operator set 500000" and "nobody set anything" into the same number. That
 * collapse is the S5 failure mechanism — a Railway
 * `DEFAULT_CONTEXT_WINDOW_TOKENS=200000` silently overrode a code default that
 * had ALREADY been corrected away from 200K, and the override survived three
 * model generations because nothing ever said it was winning. An override
 * should remain possible; it should just be impossible to forget. Callers pair
 * this with resolveContextWindow() and emit CONTEXT_WINDOW_OVERRIDE when the
 * two disagree.
 *
 * Reads process.env at CALL time (the resolveBootIndexMode pattern) so a
 * per-deployment flip needs no re-import and tests need no module reset.
 */
export function resolveContextWindowOverride(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = env.DEFAULT_CONTEXT_WINDOW_TOKENS;
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

/** Bootstrap response-size tripwire thresholds (bytes) — SRV-39 recalibration.
 *  The pre-brief-465 literals (80KB warn / 100KB error) fired the ERROR-level
 *  BOOTSTRAP_OVERSIZE diagnostic on EVERY prism boot: measured steady state is
 *  ~115KB (S166 115,803; S167 114,752; §D2 reconstruction 114,757) — already
 *  over 100KB before any growth. A permanently-firing error is ambient noise
 *  operators tune out, precisely while the append-only standing-rules registry
 *  keeps growing toward the ~234–246KB platform-offload point that previously
 *  caused TOTAL delivery failure (D-253 comments). Recalibrated against that
 *  real cap with headroom: ERROR at 200KB (~35–45KB runway before the cliff),
 *  WARN at 160KB (~40% above today's steady state — catches abnormal growth
 *  without crying wolf). The tripwire also attaches per-section byte
 *  attribution to its diagnostic context (SRV-39/SRV-68) so the operator sees
 *  WHICH section drove the size. Env-overridable for per-deployment tuning.
 *  NOTE: getting steady state under 100KB is a template-content diet
 *  (W3-F3/M-019 — framework, out of scope here); this is the server-side
 *  tripwire-correctness half. */
export const BOOTSTRAP_OVERSIZE_WARN_BYTES =
  parseInt(process.env.BOOTSTRAP_OVERSIZE_WARN_BYTES ?? "160000", 10) || 160_000;
export const BOOTSTRAP_OVERSIZE_ERROR_BYTES =
  parseInt(process.env.BOOTSTRAP_OVERSIZE_ERROR_BYTES ?? "200000", 10) || 200_000;

/* ------------------------------------------------------------------------ *
 * S202 boot-lean knobs (brief-s202b). Every knob defaults to a value chosen
 * so a deploy WITHOUT env changes is safe; each resolver reads process.env at
 * CALL time (computeSynthesisThinkingEnabled pattern) so per-deployment flips
 * and tests need no re-import. Unknown values fall back to the default —
 * never a crash.
 * ------------------------------------------------------------------------ */

/** T1 (P-1): boot rules-index delivery mode.
 *  `full` (default) ships today's standing_rules_index unchanged PLUS the new
 *  session_state_manifest (additive release — SRV-109 two-phase);
 *  `compact` ships the manifest ONLY (legacy index omitted; ≈ −20.9KB on the
 *  S208-measured prism baseline). Rollback: BOOT_INDEX_MODE=full (env-only). */
export function resolveBootIndexMode(env: NodeJS.ProcessEnv = process.env): "full" | "compact" {
  return env.BOOT_INDEX_MODE?.trim().toLowerCase() === "compact" ? "compact" : "full";
}

/** T3 (P-3): intelligence-brief boot compaction mode.
 *  `dedup` (default) drops the `**Project State (compact):**` digest line — a
 *  measured full duplicate of `current_state` in the same payload (audit
 *  §B.4) — keeping FULL Risk Flags + FULL Quality Audit; `legacy` ships the
 *  digest again. The BRIEF_COMPACT_FALLBACK spec-coupling guard is identical
 *  in both modes (D-253 lesson b). Rollback: BRIEF_COMPACT_MODE=legacy. */
export function resolveBriefCompactMode(env: NodeJS.ProcessEnv = process.env): "dedup" | "legacy" {
  return env.BRIEF_COMPACT_MODE?.trim().toLowerCase() === "legacy" ? "legacy" : "dedup";
}

/** T4 (P-4): prefetch trigger policy.
 *  `opening_only` (default) drops the `next_steps`-keyword auto-trigger (it
 *  fires on registry-style words like "queue"/"task" in nearly every handoff
 *  — audit §B.3) and caps any single summary at PREFETCH_SUMMARY_CAP_BYTES;
 *  opening-message keywords and the always-prefetched pending-doc-updates
 *  entry are kept. `legacy` restores today's exact behavior (next_steps
 *  trigger, no per-summary cap). Rollback: PREFETCH_MODE=legacy. */
export function resolvePrefetchMode(env: NodeJS.ProcessEnv = process.env): "opening_only" | "legacy" {
  return env.PREFETCH_MODE?.trim().toLowerCase() === "legacy" ? "legacy" : "opening_only";
}

/** T4: per-summary hard cap (bytes) applied in PREFETCH_MODE=opening_only.
 *  SRV-74 capped the header COUNT; a header-dense doc still measured 2,009 B
 *  (task-queue, audit §2.1 row 5). Env-overridable. */
export const PREFETCH_SUMMARY_CAP_BYTES =
  parseInt(process.env.PREFETCH_SUMMARY_CAP_BYTES ?? "1200", 10) || 1_200;

/** T5 (P-3/P-7): advisory per-item budget (bytes) for handoff Critical
 *  Context items. Items average 708 B on the measured baseline vs the
 *  template intent of 3-5 FACTS; the HANDOFF_ITEM_OVERSIZE diagnostic is
 *  WARN-ONLY at boot parse and finalize validation — never a rejection.
 *
 *  S203 audit R70 (F-B11): raised 300 -> 800. At 300 the diagnostic fired
 *  5/5 on every prism boot — a threshold below the measured mean flags
 *  everything and therefore nothing. 800 sits just above the ~708 B mean so
 *  only genuinely outsized items warn. Rollback: HANDOFF_ITEM_BUDGET_BYTES
 *  env. */
export const HANDOFF_ITEM_BUDGET_BYTES =
  parseInt(process.env.HANDOFF_ITEM_BUDGET_BYTES ?? "800", 10) || 800;

/** T6 (P-6a): boot masthead SVG knob — LEGACY. Default ON — D-249 restored
 *  graphical banners as an explicit operator choice; `off` ships
 *  `boot_masthead_svg: null` (the template's fallback path is pre-built,
 *  core-template-mcp.md:175-181). Rollback: unset or `on`.
 *
 *  Superseded as the primary control by `resolveBootMasthead` (S208 MCP-6),
 *  which needs a three-way answer rather than a boolean. This function keeps
 *  its exact semantics because it IS the alias path: a deployment that set
 *  `BOOT_MASTHEAD_SVG=off` must stay off after the upgrade without an
 *  operator touching anything. Nothing else should call it. */
export function resolveBootMastheadSvg(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.BOOT_MASTHEAD_SVG?.trim().toLowerCase();
  return !(raw === "off" || raw === "false" || raw === "0" || raw === "no");
}

/** MCP-6 (S208 PR-S2b): SINGLE-masthead knob.
 *
 *  `html` (default) populates `boot_masthead_html` and ships
 *  `boot_masthead_svg: null`; `svg` does the reverse; `off` ships BOTH null
 *  and `banner_text` — always emitted, never gated — is the render surface.
 *  Exactly one graphical masthead is populated per boot.
 *
 *  WHY: brief-720 shipped the HTML masthead ALONGSIDE the SVG one so older
 *  consumers saw no change. Both have rendered on every boot since, and the
 *  session renders one — the other is ~2.7KB of measured payload (S208
 *  `scripts/measure-boot-payload.mjs`) that no client ever reads. The kernel
 *  already says "render whichever" (core-template-mcp.md Rule 1), so shipping
 *  one is inside the existing contract.
 *
 *  PRECEDENCE (documented because two variables now overlap):
 *   1. `BOOT_MASTHEAD` naming a known mode (`html`, `svg`, `off`, or the
 *      falsy spellings `false`/`0`/`no`) wins outright, in both directions —
 *      `BOOT_MASTHEAD=svg` re-enables a masthead that `BOOT_MASTHEAD_SVG=off`
 *      disabled, and `BOOT_MASTHEAD=off` disables one the legacy knob left on.
 *   2. Otherwise — unset, empty, OR an unrecognized value — the legacy
 *      `BOOT_MASTHEAD_SVG` decides via `resolveBootMastheadSvg`: off => `off`,
 *      anything else => `html`. A TYPO in the new variable therefore falls
 *      back to the operator's existing intent and can never silently
 *      re-enable a masthead they turned off.
 *
 *  Read at CALL time (the `resolveBootIndexMode` pattern) so a per-deployment
 *  flip and its rollback are env-only, with no re-import and no deploy. */
export function resolveBootMasthead(env: NodeJS.ProcessEnv = process.env): "html" | "svg" | "off" {
  const raw = env.BOOT_MASTHEAD?.trim().toLowerCase();
  if (raw === "html" || raw === "svg") return raw;
  if (raw === "off" || raw === "false" || raw === "0" || raw === "no") return "off";
  return resolveBootMastheadSvg(env) ? "html" : "off";
}

/** T8 (F-1): finalize compose-offload mode.
 *  `files` (default) has the CS-1 draft emit complete finalization files that
 *  are server-validated, persisted to `.prism/finalize-draft.json`, and
 *  approvable at commit via `use_draft_files: true`; any validation-gate
 *  failure transparently falls back to the legacy 6-key draft response
 *  (FINALIZE_COMPOSE_FALLBACK). `legacy` disables composition entirely.
 *  Rollback: FINALIZE_COMPOSE_MODE=legacy. */
export function resolveFinalizeComposeMode(env: NodeJS.ProcessEnv = process.env): "files" | "legacy" {
  return env.FINALIZE_COMPOSE_MODE?.trim().toLowerCase() === "legacy" ? "legacy" : "files";
}

/** T8: hard size contract for the composed handoff.md draft (bytes). Aligned
 *  with HANDOFF_WARNING_SIZE (10KB) — the template's lean-handoff target. A
 *  composed draft over this is a quality-gate failure (falls back to the
 *  legacy draft response), NOT a validation rejection of operator content. */
export const FINALIZE_COMPOSE_HANDOFF_MAX_BYTES = 10_240;

/** T8: path of the persisted compose-offload draft artifact (project repo).
 *  Stateless-server bridge between action=draft and action=commit
 *  use_draft_files — the same GitHub-persistence pattern as dispatch state
 *  (D-123), scoped to the project repo like boot-test.md. Overwritten on
 *  every files-mode draft; a session_number guard makes stale drafts inert. */
export const FINALIZE_DRAFT_STATE_PATH = `.prism/finalize-draft.json`;

/** GitHub API base URL */
export const GITHUB_API_BASE = "https://api.github.com";

/** Handoff size thresholds (bytes) */
export const HANDOFF_WARNING_SIZE = 10_240;   // 10 KB — needs-attention
export const HANDOFF_CRITICAL_SIZE = 15_360;  // 15 KB — scaling required

/** Standing-rules registry finalize-time size tripwire (bytes) — SRV-69.
 *  standing-rules.md is on three hot read paths (boot union, prism_load_rules,
 *  synthesis) but — unlike its size-capped siblings session-log.md (15KB) and
 *  insights.md (20KB) — had NO size lifecycle. It is append-mostly and was
 *  measured at 394,693 B (≈26× insights' threshold). This is a WARNING tripwire
 *  only (mirroring handoff.md's threshold): server-side truncation of standing
 *  rules would silently lose intelligence (Tier A has no lazy-load recovery), so
 *  the operator curates — the server's job is to surface the growth. A real
 *  retention/archival mechanism is a larger change; this is the minimum
 *  finalize-time visibility the audit asks for. Env-overridable. */
export const STANDING_RULES_WARNING_SIZE =
  parseInt(process.env.STANDING_RULES_WARNING_SIZE ?? "150000", 10) || 150_000;

/** Summary mode threshold (bytes) */
export const SUMMARY_SIZE_THRESHOLD = 5_120;  // 5 KB

/** Root directory for PRISM living documents within project repos (D-67) */
export const DOC_ROOT = ".prism";

/** Anthropic API key for synthesis (Track 2) */
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";

/** Model to use for synthesis. Default centralized in src/models.ts
 *  (SYNTHESIS_MODEL_ID) so a model change touches one place; override
 *  per-deployment via the SYNTHESIS_MODEL env var. Any bump to the
 *  centralized default is gated by INS-244 / INS-245 (OAuth-surface
 *  availability). */
export const SYNTHESIS_MODEL = process.env.SYNTHESIS_MODEL ?? SYNTHESIS_MODEL_ID;

/** Whether synthesis is enabled — SRV-60.
 *  Pre-brief-465 this was keyed SOLELY to ANTHROPIC_API_KEY, so a deployment
 *  with ONLY CLAUDE_CODE_OAUTH_TOKEN could not synthesize even when every
 *  call-site explicitly routes to the cc_subprocess transport (which uses the
 *  OAuth surface, not the API key) — the gate short-circuited before routing was
 *  ever consulted. Widened: enabled when the API key is present OR an OAuth token
 *  is present AND at least one synthesis call-site is configured for
 *  cc_subprocess. The messages_api path still requires ANTHROPIC_API_KEY (its own
 *  callMessagesApi DISABLED guard enforces that), so this only UN-blocks the
 *  legitimate OAuth-only + cc_subprocess deployment. */
export function computeSynthesisEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ANTHROPIC_API_KEY) return true;
  return (
    !!env.CLAUDE_CODE_OAUTH_TOKEN &&
    [
      "SYNTHESIS_BRIEF_TRANSPORT",
      "SYNTHESIS_PDU_TRANSPORT",
      "SYNTHESIS_DRAFT_TRANSPORT",
    ].some((k) => env[k] === "cc_subprocess")
  );
}
export const SYNTHESIS_ENABLED = computeSynthesisEnabled();

/** Per-call-site adaptive-thinking switch for fire-and-forget synthesis.
 *  Defaults on to preserve the Phase 3a behavior. Set
 *  SYNTHESIS_BRIEF_THINKING=false or SYNTHESIS_PDU_THINKING=false to opt a
 *  specific background call site out without changing model or transport. */
export function computeSynthesisThinkingEnabled(
  callSite: "brief" | "pdu",
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[`SYNTHESIS_${callSite.toUpperCase()}_THINKING`]?.trim().toLowerCase();
  if (!raw) return true;
  if (["false", "0", "no", "off"].includes(raw)) return false;
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  return true;
}

/** Max output tokens for synthesis calls. Bumped from 4096 → 8192 for Phase 3a:
 *  adaptive thinking on Opus 4.8 emits internal thinking content blocks that
 *  are counted against max_tokens. Text-output budget after thinking overhead
 *  remains ample for the 2K–4K-token brief target. */
export const SYNTHESIS_MAX_OUTPUT_TOKENS = 8192;

/** Timeout for post-finalization synthesis (S34d). Separate from MCP_SAFE_TIMEOUT
 *  because synthesis runs after commit succeeds and is best-effort/non-fatal.
 *  Phase 3a bump from 120_000 → 240_000 default and made env-overridable: S71
 *  baseline p95 was 118.9s on Opus 4.6 *without* thinking; adaptive thinking
 *  adds variable per-request output, so doubling the ceiling absorbs the new
 *  variance without pinching any real call. Synthesis is fire-and-forget per
 *  D-78 so longer ceiling has no operator-visible cost. */
export const SYNTHESIS_TIMEOUT_MS =
  parseInt(process.env.SYNTHESIS_TIMEOUT_MS ?? "240000", 10) || 240_000;

/** Wall-clock deadline (ms) for the PDU synthesis call when routed through
 *  the Claude Code subprocess (cc_subprocess transport). Distinct from
 *  SYNTHESIS_TIMEOUT_MS (which governs the messages_api fire-and-forget path)
 *  because cc_subprocess has additional overhead beyond inference: CLI spawn,
 *  OAuth handshake, model load, and token streaming. Default 600s absorbs
 *  realistic end-to-end variance (observed messages_api inference: 82-132s;
 *  subprocess overhead estimated 30-60s additional) while still catching
 *  genuinely stuck processes. Configurable via env var so operators can
 *  tune per-deployment without code change. */
export const CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS =
  parseInt(process.env.CC_SUBPROCESS_SYNTHESIS_TIMEOUT_MS ?? "600000", 10) || 600_000;

/** Hard ceiling (estimated tokens) for the COMBINED synthesis input — the
 *  assembled user message that generateIntelligenceBrief and
 *  generatePendingDocUpdates feed to the model (brief-445 / R3-dur / D-240
 *  Phase B, audit brief-431 row R3). Pre-438 the assembled input reached
 *  ~611KB / ~175K tokens (insights.md dominant) and tripped the CS-1
 *  SYNTHESIS_TIMEOUT; R3-imm (brief-438) migrated the dominant data out.
 *  This constant is the DURABLE backstop: when the assembled input would
 *  exceed it, src/ai/input-budget.ts deterministically priority-trims the
 *  largest / lowest-signal docs back under budget instead of letting the
 *  call run into the timeout. Enforced in estimated tokens
 *  (chars / SYNTHESIS_CHARS_PER_TOKEN), not raw bytes. */
export const SYNTHESIS_INPUT_MAX_TOKENS =
  parseInt(process.env.SYNTHESIS_INPUT_MAX_TOKENS ?? "120000", 10) || 120_000;

/** Design target (estimated tokens) for the assembled synthesis input.
 *  Two roles (brief-445 / R3-dur):
 *  1. Trim goal — when the input exceeds SYNTHESIS_INPUT_MAX_TOKENS, the
 *     trim reduces it to <= this target rather than stopping just under the
 *     ceiling. Living docs only grow, so trimming to the ceiling would pin
 *     every subsequent finalize at the timeout-adjacent boundary and re-trim
 *     on every run with minimal headroom; trimming to the target restores
 *     durable headroom and emits a clear signal (input_trimmed in the
 *     synthesis logs) for the operator to schedule data hygiene like
 *     brief-438.
 *  2. NO-OP floor — inputs at or under the ceiling are NEVER trimmed
 *     (normal-case NO-OP per the R3-dur brief author note); post-438 inputs
 *     sit well under this target. */
export const SYNTHESIS_INPUT_TARGET_TOKENS =
  parseInt(process.env.SYNTHESIS_INPUT_TARGET_TOKENS ?? "60000", 10) || 60_000;

/** Calibrated chars-per-token ratio for synthesis input estimation — SRV-62.
 *  The codebase-standard proxy for Claude tokenization of markdown-heavy English
 *  (a real tokenizer is deliberately NOT used: the SDK ships none locally and
 *  countTokens is a network call — wrong for this fire-and-forget cap).
 *
 *  Fable 5 previously used a heavier 2.7 proxy. After the 2026-06-25 Fable
 *  availability rollback, Opus-tier 3.5 is again the active fallback default,
 *  but explicit stale Fable env overrides still get the conservative estimate.
 *  Lower ratio = MORE estimated tokens = earlier, safer trimming. */
export function synthesisCharsPerToken(model: string): number {
  return /fable/i.test(model) ? 2.7 : 3.5;
}
export const SYNTHESIS_CHARS_PER_TOKEN = synthesisCharsPerToken(SYNTHESIS_MODEL);

/** Tool-level wall-clock deadline for prism_push (S40 C4). Hard backstop on
 *  top of the per-request GitHub fetch timeout. Configurable via env var so
 *  tests can inject a much smaller value without waiting in CI.
 *
 *  SRV-97 (brief-461): default lowered 60s -> MCP_SAFE_TIMEOUT (50s). At 60s
 *  the value sat AT the ~60s MCP client ceiling, so the client could give up
 *  (errored turn) before this deadline fired and the abandoned mutation could
 *  land afterwards. Keeping it <= MCP_SAFE_TIMEOUT guarantees the structured
 *  DEADLINE_EXCEEDED response reaches the client first (and safeMutation now
 *  aborts the in-flight commit on expiry — SRV-42). */
export const PUSH_WALL_CLOCK_DEADLINE_MS =
  parseInt(process.env.PUSH_WALL_CLOCK_DEADLINE_MS ?? `${MCP_SAFE_TIMEOUT}`, 10) || MCP_SAFE_TIMEOUT;

/** Tool-level wall-clock deadline for prism_finalize commit phase (S40 C4).
 *
 *  SRV-47/97 (brief-461): default lowered 90s -> MCP_SAFE_TIMEOUT (50s). 90s
 *  deliberately exceeded the ~60s client ceiling, which was the documented
 *  root of the errored-turn-retry-duplicates-archive class: the client saw an
 *  errored turn, the server finished the commit afterwards, and the operator's
 *  retry double-appended. With the deadline under the ceiling the client gets
 *  a clean structured error; safeMutation aborts the in-flight commit (SRV-42)
 *  and archival is idempotent across retries (SRV-47). */
export const FINALIZE_COMMIT_DEADLINE_MS =
  parseInt(process.env.FINALIZE_COMMIT_DEADLINE_MS ?? `${MCP_SAFE_TIMEOUT}`, 10) || MCP_SAFE_TIMEOUT;

/** Per-call wall-clock budget (ms) for prism_patch (S63 Phase 1 Brief 3).
 *  Bounds the entire patch operation — fetch + N applyPatch + integrity
 *  validate + atomic commit (and any 409 retry the safeMutation primitive
 *  performs). Exceeding this deadline causes safeMutation to return
 *  `{ ok: false, code: "DEADLINE_EXCEEDED" }` and emit a DEADLINE_EXCEEDED
 *  diagnostic. Configurable via env var so tests can inject a much smaller
 *  value without waiting in CI.
 *
 *  SRV-97 (brief-461): default lowered 60s -> MCP_SAFE_TIMEOUT (50s). The old
 *  comment claimed 60s stayed "below the MCP client's ~60s ceiling" — it did
 *  not; 60s IS the ceiling. Bringing it to <= MCP_SAFE_TIMEOUT makes the claim
 *  true and lets the structured deadline error reach the client first. */
export const PATCH_WALL_CLOCK_DEADLINE_MS =
  parseInt(process.env.PATCH_WALL_CLOCK_DEADLINE_MS ?? `${MCP_SAFE_TIMEOUT}`, 10) || MCP_SAFE_TIMEOUT;

/** Tool-level wall-clock deadline for prism_scale_handoff (SRV-64 / brief-461).
 *  prism_scale_handoff previously had ONLY cooperative between-stage checks
 *  (SAFETY_TIMEOUT_MS) — stage-1 fetch and stage-6 commit were unbounded, so a
 *  hung GitHub call held the MCP client connection until the transport gave up
 *  with no structured error. This is the hard backstop that mirrors the
 *  push.ts/patch.ts sentinel pattern: a Promise.race around the whole scale
 *  operation. Default MCP_SAFE_TIMEOUT (50s) so the structured deadline error
 *  reaches the client before the ~60s ceiling. Env-overridable so tests inject
 *  a small value without waiting in CI. */
export const SCALE_WALL_CLOCK_DEADLINE_MS =
  parseInt(process.env.SCALE_WALL_CLOCK_DEADLINE_MS ?? `${MCP_SAFE_TIMEOUT}`, 10) || MCP_SAFE_TIMEOUT;

/** Tool-level wall-clock deadlines for the four read-path tools (brief-444
 *  R-deadlines / D-240 Phase B / audit brief-431). prism_analytics,
 *  prism_search, prism_status, and prism_fetch previously had NO deadline —
 *  only the four mutation tools (push, finalize, patch, cc_dispatch) carried
 *  one — so a
 *  hung GitHub fan-out held the MCP client connection until the ~60s
 *  transport timeout with no structured error. Same pattern as
 *  PUSH_WALL_CLOCK_DEADLINE_MS: hard backstop on top of the per-request
 *  GitHub fetch timeout (15s), env-overridable so tests can inject a small
 *  value without waiting in CI. Default is MCP_SAFE_TIMEOUT (50s): for
 *  read-only tools the structured error must reach the client BEFORE the
 *  transport gives up — unlike the mutation tools, there is no partial
 *  repo state worth waiting longer to report on. */
export const ANALYTICS_WALL_CLOCK_DEADLINE_MS =
  parseInt(process.env.ANALYTICS_WALL_CLOCK_DEADLINE_MS ?? `${MCP_SAFE_TIMEOUT}`, 10) || MCP_SAFE_TIMEOUT;
export const SEARCH_WALL_CLOCK_DEADLINE_MS =
  parseInt(process.env.SEARCH_WALL_CLOCK_DEADLINE_MS ?? `${MCP_SAFE_TIMEOUT}`, 10) || MCP_SAFE_TIMEOUT;
export const STATUS_WALL_CLOCK_DEADLINE_MS =
  parseInt(process.env.STATUS_WALL_CLOCK_DEADLINE_MS ?? `${MCP_SAFE_TIMEOUT}`, 10) || MCP_SAFE_TIMEOUT;
export const FETCH_WALL_CLOCK_DEADLINE_MS =
  parseInt(process.env.FETCH_WALL_CLOCK_DEADLINE_MS ?? `${MCP_SAFE_TIMEOUT}`, 10) || MCP_SAFE_TIMEOUT;

/** Tool-level wall-clock deadline for prism_bootstrap (S203 audit R23 /
 *  F-C1-5). Bootstrap was the last fan-out tool with NO hard backstop — a
 *  hung core fetch held the MCP client connection until the ~60s transport
 *  timeout with no structured error, on the one tool every session runs
 *  first. Same sentinel/race pattern as PUSH_WALL_CLOCK_DEADLINE_MS. */
export const BOOTSTRAP_WALL_CLOCK_DEADLINE_MS =
  parseInt(process.env.BOOTSTRAP_WALL_CLOCK_DEADLINE_MS ?? `${MCP_SAFE_TIMEOUT}`, 10) ||
  MCP_SAFE_TIMEOUT;

/** Tool-level wall-clock deadline for prism_load_rules (S208 PR-S2a / MCP-2).
 *  prism_load_rules fans out to two rule sources whose bodies are the largest
 *  documents PRISM reads (prism's standing-rules.md is ~320KB); a stalled
 *  fetch on either held the MCP client to the ~60s transport timeout with no
 *  structured error, the same gap R23 closed for prism_bootstrap. Default
 *  MCP_SAFE_TIMEOUT so the structured DEADLINE response still reaches the
 *  client; same sentinel/race pattern as PUSH_WALL_CLOCK_DEADLINE_MS. */
export const LOAD_RULES_WALL_CLOCK_DEADLINE_MS =
  parseInt(process.env.LOAD_RULES_WALL_CLOCK_DEADLINE_MS ?? `${MCP_SAFE_TIMEOUT}`, 10) ||
  MCP_SAFE_TIMEOUT;

/** Total elapsed-time budget (ms) across ALL retries inside fetchWithRetry
 *  (S203 audit R24 / F-C1-8). Bounds worst-case honored Retry-After chains:
 *  without it, three 60s Retry-After responses could hold a caller ~300s —
 *  far past every tool deadline. Once the budget is exhausted the client
 *  stops retrying and surfaces the last response/error.
 *
 *  MCP-14 (S208 PR-S2a): the budget now bounds TOTAL elapsed attempt time, not
 *  only the backoff sleeps. No retry starts once the remaining budget is spent,
 *  and each retry's per-request timeout is clamped to what is left, so a chain
 *  of slow-but-not-timed-out attempts can no longer overrun the budget. The
 *  FIRST attempt keeps the full per-request timeout, so a single-attempt call
 *  behaves exactly as before. */
export const GITHUB_RETRY_BUDGET_MS =
  parseInt(process.env.GITHUB_RETRY_BUDGET_MS ?? "20000", 10) || 20_000;

/** Per-file content cap (bytes) for prism_fetch full-content delivery
 *  (brief-444 R-deadlines, second half). Without a cap, fetching one large
 *  file (oversize session log, JSON artifact, generated report) could blow
 *  the ~25K-token (~100KB) MCP response ceiling and flood session context.
 *  Files larger than this deliver the leading bytes (cut at a line
 *  boundary) plus an explicit truncation notice; callers opt out per-call
 *  with `full_content: true`. 50KB ≈ 14K tokens — passes every healthy
 *  living document untouched (handoff critical threshold is 15KB) while
 *  keeping any single file under half the response ceiling. Summary mode
 *  (`summary_mode: true`) is unaffected — summaries are already compact. */
export const FETCH_CONTENT_CAP_BYTES =
  parseInt(process.env.FETCH_CONTENT_CAP_BYTES ?? "50000", 10) || 50_000;

/** Aggregate response budget (bytes) for prism_fetch — SRV-63.
 *  FETCH_CONTENT_CAP_BYTES bounds any SINGLE file, but the files[] array is
 *  unbounded: N files each under the per-file cap can still blow the ~25K-token
 *  (~100KB) MCP response ceiling. Once cumulative delivered bytes cross this
 *  budget, the remaining files (request order) are delivered size-only (true
 *  size + a withheld notice + is_aggregate_capped) with a
 *  FETCH_AGGREGATE_BUDGET_EXCEEDED diagnostic — never a silent omission. 90KB
 *  leaves headroom under the response ceiling. Env-overridable. */
export const FETCH_AGGREGATE_BUDGET_BYTES =
  parseInt(process.env.FETCH_AGGREGATE_BUDGET_BYTES ?? "90000", 10) || 90_000;

/** Per-attempt timeout for the Opus call inside prism_finalize draft phase.
 *  Accommodates large-project single-attempt latency (S41 — observed ~100s
 *  ceiling on PF-v2-scale inputs). Configurable via env for per-deployment
 *  tuning. */
export const FINALIZE_DRAFT_TIMEOUT_MS =
  parseInt(process.env.FINALIZE_DRAFT_TIMEOUT_MS ?? "150000", 10) || 150_000;

/** Tool-level wall-clock deadline for the prism_finalize draft phase (S41).
 *  Hard backstop on top of the per-attempt timeout — prevents any retry logic
 *  or unexpected blocking from holding the MCP client connection
 *  indefinitely. Mirrors FINALIZE_COMMIT_DEADLINE_MS pattern.
 *
 *  Governs the BACKGROUND fullPhase race only; the interactive `action=draft`
 *  race is bounded by FINALIZE_DRAFT_ACTION_DEADLINE_MS below (S203 audit
 *  R32 / F-C1-7). */
export const FINALIZE_DRAFT_DEADLINE_MS =
  parseInt(process.env.FINALIZE_DRAFT_DEADLINE_MS ?? "180000", 10) || 180_000;

/** Wall-clock deadline for the INTERACTIVE `action=draft` race (S203 audit
 *  R32 / F-C1-7). At 180s the draft deadline was 3x the ~60s MCP client
 *  ceiling, so the structured timeout response could never be delivered: the
 *  client gave up first and the operator's retry started a SECOND synthesis.
 *
 *  Same SRV-97 lowering PUSH_WALL_CLOCK_DEADLINE_MS took — default
 *  MCP_SAFE_TIMEOUT so the structured error reaches the client before the
 *  transport gives up. An EXPLICITLY env-set FINALIZE_DRAFT_DEADLINE_MS still
 *  wins verbatim (the R32 rollback lever, and the only way back to a >50s
 *  interactive draft); fullPhase's background race keeps the longer
 *  FINALIZE_DRAFT_DEADLINE_MS / FINALIZE_DRAFT_DEADLINE_CC_MS constants
 *  regardless.
 *
 *  MCP-1 v4 truth-up (S208 PR-S1): the earlier trailing claim that the
 *  background race "is not bounded by a client turn" was false as written.
 *  What is true is a CALLER distinction, not a transport one. action=full's
 *  intended caller is the Trigger / Claude Code path, which drives the server
 *  without the ~60s MCP client ceiling; the chat path is expected to run the
 *  phased audit -> draft -> commit sequence instead. The action enum cannot
 *  structurally prevent a chat client from calling action=full, and when one
 *  does, that turn IS bounded by its own client ceiling -- a stated residual,
 *  not a guarantee. */
export const FINALIZE_DRAFT_ACTION_DEADLINE_MS =
  process.env.FINALIZE_DRAFT_DEADLINE_MS !== undefined
    ? FINALIZE_DRAFT_DEADLINE_MS
    : MCP_SAFE_TIMEOUT;

/** Deadline for the fullPhase draft race when the draft transport is
 *  cc_subprocess. cc_subprocess draft runs longer than the messages_api
 *  default (observed 130–240s), so 300s gives headroom above the observed
 *  latency while bounding the worst-case background-finalize block.
 *  Configurable via env var for per-deployment tuning. */
export const FINALIZE_DRAFT_DEADLINE_CC_MS =
  parseInt(process.env.FINALIZE_DRAFT_DEADLINE_CC_MS ?? "300000", 10) || 300_000;

/** S208 widget_channel binding: the prefix that marks a Critical Context item
 *  as the widget-channel health flag rather than a substantive session fact.
 *  The boot kernel keys on the `widget_channel: down` substring appearing
 *  ANYWHERE in critical_context -- never on a dedicated slot -- so the flag
 *  must survive both the 5-item compose gate and handoff condensation. */
export const WIDGET_CHANNEL_ITEM_PREFIX = "widget_channel:";

/** True when a Critical Context item is the widget_channel flag. Leading
 *  markdown list markers and numbering are already stripped by the callers'
 *  list parsers; leading whitespace and case are tolerated here so an
 *  operator-typed variant still gets its exemption. */
export function isWidgetChannelItem(item: string): boolean {
  return item.trimStart().toLowerCase().startsWith(WIDGET_CHANNEL_ITEM_PREFIX);
}

/** MCP-1c (S208 PR-S1): wall-clock deadline for the STANDALONE `action=audit`
 *  handler. The audit fans out ten `resolveDocPath` reads plus a commit-history
 *  probe per unfetched doc, and it was the last finalize action with no bound
 *  at all: a hung GitHub read held the client connection to the ~60s transport
 *  timeout and the operator got a dead turn instead of a structured error.
 *  Defaults to MCP_SAFE_TIMEOUT so the structured response still reaches the
 *  client. Env-overridable (`FINALIZE_AUDIT_DEADLINE_MS`) as the rollback
 *  lever. */
export const FINALIZE_AUDIT_ACTION_DEADLINE_MS =
  parseInt(process.env.FINALIZE_AUDIT_DEADLINE_MS ?? "", 10) || MCP_SAFE_TIMEOUT;

/** MCP-1d (S208 PR-S1): anti-hang bound for fullPhase's INTERNAL audit step.
 *  Deliberately far wider than the action bound above (action=full's intended
 *  caller is the Trigger / Claude Code path, which has no ~60s client ceiling
 *  -- see FINALIZE_DRAFT_ACTION_DEADLINE_MS), so this is a hang breaker, not a
 *  latency budget. Expiry degrades FAIL-CLOSED: every living document counts
 *  `unverified`, so the INS-360 recreate guard drops file-shaped draft keys
 *  rather than committing a from-scratch replacement over live history. */
export const FINALIZE_FULL_AUDIT_DEADLINE_MS =
  parseInt(process.env.FINALIZE_FULL_AUDIT_DEADLINE_MS ?? "120000", 10) || 120_000;

/** MCP-2 (S208 PR-S1): call-site race bound (ms) for the finalization banner's
 *  decision-index read. The banner is assembled AFTER the atomic commit, so an
 *  un-raced `resolveDocPath` there could hold a completed finalization hostage
 *  to a slow GitHub read. Losing the race renders `? decisions (unverified)` --
 *  an unknown reported as unknown, never a confident zero. */
export const BANNER_DECISIONS_RACE_MS =
  parseInt(process.env.BANNER_DECISIONS_RACE_MS ?? "3000", 10) || 3_000;

/** OPS-2 (S208 PR-S1): finalization-banner widget kill switch, the finalize
 *  mirror of BOOT_MASTHEAD_SVG. `html` (default) emits
 *  `finalization_banner_html`; `off` ships it as null. `banner_text` is
 *  DELIBERATELY unaffected either way -- it is the genuine fallback and the
 *  render contract's FALLBACK clause depends on it always being there.
 *  Read at CALL time so a per-deployment flip needs no re-import. */
export function resolveFinalizeBanner(env: NodeJS.ProcessEnv = process.env): "html" | "off" {
  const raw = env.FINALIZE_BANNER?.trim().toLowerCase();
  return raw === "off" || raw === "false" || raw === "0" || raw === "no" ? "off" : "html";
}

/** The 10 mandatory PRISM living documents (D-18, D-41, D-44, D-67) */
export const LIVING_DOCUMENTS = [
  `${DOC_ROOT}/handoff.md`,
  `${DOC_ROOT}/decisions/_INDEX.md`,
  `${DOC_ROOT}/session-log.md`,
  `${DOC_ROOT}/task-queue.md`,
  `${DOC_ROOT}/eliminated.md`,
  `${DOC_ROOT}/architecture.md`,
  `${DOC_ROOT}/glossary.md`,
  `${DOC_ROOT}/known-issues.md`,
  `${DOC_ROOT}/insights.md`,
  `${DOC_ROOT}/intelligence-brief.md`,
] as const;

/** Canonical list of living-document filenames WITHOUT the DOC_ROOT prefix.
 *  Consumed by resolveDocPath() and resolveDocFiles() — both of which prepend
 *  `.prism/` internally. Distinct from LIVING_DOCUMENTS (which is the prefixed
 *  form used when calling GitHub APIs directly without the resolver). Keep both
 *  in sync when adding or removing a living document. */
export const LIVING_DOCUMENT_NAMES = [
  "handoff.md",
  "decisions/_INDEX.md",
  "session-log.md",
  "task-queue.md",
  "eliminated.md",
  "architecture.md",
  "glossary.md",
  "known-issues.md",
  "insights.md",
  "intelligence-brief.md",
] as const;

/** Valid commit prefixes */
export const VALID_COMMIT_PREFIXES = [
  "prism:", "fix:", "docs:", "chore:",
  "audit:", // audit reports and audit-trail commits
  "test:",  // test artifacts and test-scope fixtures
] as const;

/**
 * Project slug → display name mapping for boot banner (D-34).
 * Only entries where title-casing the slug would produce an incorrect name.
 * Unlisted slugs fall back to title-cased slug (e.g., "allevio-systems" → "Allevio Systems").
 */
export const PROJECT_DISPLAY_NAMES: Record<string, string> = {
  "prism": "PRISM Framework",
  "prism-mcp-server": "PRISM MCP Server",
  "prism-cash-plus-pawn-ftp": "Cash Plus Pawn FTP",
  "platformforge": "PlatformForge",
  "platformforge-v2": "PlatformForge v2",
  "snapquote-ai": "SnapQuote",
  "resvault": "ResVault",
  "OpenClaw": "OpenClaw",
  "paypal-aaa-arbitration": "PayPal AAA Arbitration",
  "chill-bar-and-grill": "Chill Bar & Grill",
};

/**
 * Reverse map: display name (lowercase) → slug.
 * Derived from PROJECT_DISPLAY_NAMES for server-side slug resolution (KI-15).
 */
// Internal lookup for resolveProjectSlug only (SRV-113: demoted from exported —
// callers resolve display names via resolveProjectSlug, not this map directly).
const DISPLAY_NAME_TO_SLUG: Record<string, string> = Object.fromEntries(
  Object.entries(PROJECT_DISPLAY_NAMES).map(([slug, name]) => [name.toLowerCase(), slug])
);

/**
 * Resolve a project identifier to a slug.
 * Accepts: exact slug, display name (case-insensitive), or Claude project name.
 * Returns the slug if found, or the original input if no match (let it fail downstream with a clear error).
 */
export function resolveProjectSlug(input: string): string {
  const lowerInput = input.toLowerCase().trim();
  const slugs = Object.keys(PROJECT_DISPLAY_NAMES);

  // 1. Direct slug match
  if (slugs.includes(lowerInput)) return lowerInput;

  // 2. Case-sensitive slug match (for slugs like "OpenClaw")
  if (slugs.includes(input.trim())) return input.trim();

  // 3. Display name match (case-insensitive)
  if (DISPLAY_NAME_TO_SLUG[lowerInput]) return DISPLAY_NAME_TO_SLUG[lowerInput];

  // 4. Normalized match — strip spaces, hyphens, underscores for comparison
  const normalize = (s: string) => s.toLowerCase().replace(/[-_\s]/g, "");
  const normalizedInput = normalize(input);
  for (const slug of slugs) {
    if (normalize(slug) === normalizedInput) return slug;
    const displayName = PROJECT_DISPLAY_NAMES[slug];
    if (displayName && normalize(displayName) === normalizedInput) return slug;
  }

  // 5. No match — return original input, bootstrap will fail with a clear "repo not found" error
  return input;
}

/** Keyword → living document mapping for bootstrap pre-fetching.
 * QW-3 (S29): Removed overly generic keywords (next, plan, session, previous, issue, error)
 * that caused false-positive prefetches on common opening messages.
 * D-67: Paths prefixed with DOC_ROOT. */
export const PREFETCH_KEYWORDS: Record<string, string> = {
  architecture: `${DOC_ROOT}/architecture.md`,
  stack: `${DOC_ROOT}/architecture.md`,
  infrastructure: `${DOC_ROOT}/architecture.md`,
  deploy: `${DOC_ROOT}/architecture.md`,
  integration: `${DOC_ROOT}/architecture.md`,
  bug: `${DOC_ROOT}/known-issues.md`,
  workaround: `${DOC_ROOT}/known-issues.md`,
  debt: `${DOC_ROOT}/known-issues.md`,
  term: `${DOC_ROOT}/glossary.md`,
  definition: `${DOC_ROOT}/glossary.md`,
  glossary: `${DOC_ROOT}/glossary.md`,
  task: `${DOC_ROOT}/task-queue.md`,
  priority: `${DOC_ROOT}/task-queue.md`,
  queue: `${DOC_ROOT}/task-queue.md`,
  backlog: `${DOC_ROOT}/task-queue.md`,
  reject: `${DOC_ROOT}/eliminated.md`,
  eliminate: `${DOC_ROOT}/eliminated.md`,
  guardrail: `${DOC_ROOT}/eliminated.md`,
  "why not": `${DOC_ROOT}/eliminated.md`,
  tried: `${DOC_ROOT}/eliminated.md`,
  history: `${DOC_ROOT}/session-log.md`,
  "last time": `${DOC_ROOT}/session-log.md`,
  insight: `${DOC_ROOT}/insights.md`,
  pattern: `${DOC_ROOT}/insights.md`,
  preference: `${DOC_ROOT}/insights.md`,
  gotcha: `${DOC_ROOT}/insights.md`,
  learned: `${DOC_ROOT}/insights.md`,
};

// SRV-108: STANDING_RULE_TOPIC_KEYWORDS (and its sole consumer topicMatch) was
// removed — the D-156 keyword-expansion boot path has been dead since R7-b/
// D-253 made Tier B/C lazy-loaded by explicit topic via prism_load_rules.

/** MCP Auth Token for Bearer authentication (B.2) */
export const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";

/**
 * S208 PR-S3 / audit R20: require a Bearer credential whenever one is
 * configured. DEFAULT `false` -- with the knob off, `authMiddleware` behaves
 * exactly as it did in 4.13.2: a request carrying NO `Authorization` header
 * (or one that is not a Bearer header) falls through to the IP allowlist, and
 * an allowlisted source is served with no credential at all. That
 * fall-through is the finding: `MCP_AUTH_TOKEN` reads like a required
 * credential while a caller inside the allowlisted CIDR never has to present
 * it, so the token's real strength is the allowlist's.
 *
 * With the knob ON and `MCP_AUTH_TOKEN` set, a missing or non-Bearer
 * `Authorization` header is rejected 401 instead of falling through. `/health`
 * stays exempt in both modes (Railway's probe sends no credential).
 *
 * Shipped default-OFF DELIBERATELY: the live connector's auth posture is
 * UNKNOWN at merge time, and flipping this blind would lock out a client that
 * authenticates by source IP today. The flip is an operator action taken after
 * confirming the live client sends Bearer; rollback is env-only
 * (`AUTH_REQUIRE_BEARER=false`), no deploy.
 *
 * Reads process.env at CALL time (the resolveBootIndexMode pattern) so the
 * flip needs no re-import and tests need no module reset. Anything other than
 * a true-ish token (`true`/`1`/`yes`/`on`, case-insensitive) is the default:
 * an unparseable value must never silently harden auth.
 */
export function resolveAuthRequireBearer(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.AUTH_REQUIRE_BEARER?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

/** Railway API token (workspace-scoped). Required to enable Railway tools. */
export const RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN ?? "";

/** Railway workspace ID for workspace-scoped API tokens. */
export const RAILWAY_WORKSPACE_ID = process.env.RAILWAY_WORKSPACE_ID ?? "";

/** Railway GraphQL API endpoint */
export const RAILWAY_API_ENDPOINT =
  process.env.RAILWAY_API_ENDPOINT ?? "https://backboard.railway.app/graphql/v2";

/** Whether Railway tools are enabled. Requires RAILWAY_API_TOKEN to be set. */
export const RAILWAY_ENABLED = !!RAILWAY_API_TOKEN;

/** Claude Code OAuth token (sk-ant-oat01-*). Generated by `claude setup-token`
 *  from a Mac signed into a Claude Max subscription. Used to authenticate
 *  the spawned Claude Code subprocess in cc_dispatch. Distinct from
 *  ANTHROPIC_API_KEY — CC's auth precedence ladder treats them as separate
 *  credentials, and the synthesis layer (src/ai/) continues to use
 *  ANTHROPIC_API_KEY independently because Anthropic's Messages API rejects
 *  OAuth tokens for direct programmatic access. */
export const CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";

/**
 * Claude Code orchestration layer (brief-104 / workstream B; auth migrated S56).
 *
 * The `cc_dispatch` and `cc_status` tools use `@anthropic-ai/claude-agent-sdk`
 * to programmatically dispatch tasks to Claude Code from claude.ai sessions.
 * Authentication is via `CLAUDE_CODE_OAUTH_TOKEN` (Claude Max subscription
 * OAuth issued by `claude setup-token`) — distinct from the synthesis layer,
 * which continues to use `ANTHROPIC_API_KEY` independently because Anthropic's
 * Messages API rejects OAuth tokens for direct programmatic access. When
 * `CLAUDE_CODE_OAUTH_TOKEN` is unset, `cc_dispatch` and `cc_status` are simply
 * not registered, so existing deployments without the OAuth token are
 * unaffected.
 */
export const CC_DISPATCH_ENABLED = !!CLAUDE_CODE_OAUTH_TOKEN;

/** Default model for Claude Code dispatch. Default centralized in
 *  src/models.ts (CC_DISPATCH_MODEL_ID) so a model change touches one place;
 *  override per-deployment via the CC_DISPATCH_MODEL env var. */
export const CC_DISPATCH_MODEL = process.env.CC_DISPATCH_MODEL ?? CC_DISPATCH_MODEL_ID;

/** Max turns for Claude Code dispatch (default). Can be overridden per-call. */
export const CC_DISPATCH_MAX_TURNS = parseInt(
  process.env.CC_DISPATCH_MAX_TURNS ?? "50",
  10,
);

/** Effort level for Claude Code dispatch.
 *  Controls reasoning depth via the Anthropic API effort parameter.
 *  Accepted values: "low", "medium", "high", "xhigh", "max".
 *  On first-party Anthropic / Claude Code surfaces, Sonnet 5 supports
 *  "max" for the highest available reasoning capability.
 *  Defaults to "max" for maximum intelligence. Override via env var. */
export const CC_DISPATCH_EFFORT = process.env.CC_DISPATCH_EFFORT ?? "max";

/**
 * Per-call wall-clock budget (ms) for SYNC mode `cc_dispatch`.
 *
 * This is the hard deadline passed to the Agent SDK's AbortController. It
 * MUST stay below `MCP_SAFE_TIMEOUT` minus serialization overhead (~5s) so
 * the MCP response can be written back to the client before the transport
 * times out. Raising it past ~55s causes the MCP client to give up before
 * the server returns (MCP architectural ceiling of ~60s).
 *
 * For tasks expected to exceed this budget, callers should pass
 * `async_mode: true` — async dispatches have no deadline.
 *
 * Configurable via the `CC_DISPATCH_SYNC_TIMEOUT_MS` environment variable.
 */
export const CC_DISPATCH_SYNC_TIMEOUT_MS =
  parseInt(process.env.CC_DISPATCH_SYNC_TIMEOUT_MS ?? `${MCP_SAFE_TIMEOUT - 5_000}`, 10) || (MCP_SAFE_TIMEOUT - 5_000);

/**
 * Dispatch state lives in the dedicated `brdonath1/prism-dispatch-state` repo
 * (D-123), NOT in this repo — keeping it separate stops dispatch-record writes
 * from triggering Railway auto-deploys that would kill in-flight dispatches.
 * Records are persisted to GitHub so cc_status can read them across stateless
 * server requests; CC_DISPATCH_STATE_DIR is the path within that state repo.
 */
export const CC_DISPATCH_STATE_REPO = "prism-dispatch-state";
export const CC_DISPATCH_STATE_DIR = ".dispatch";

/**
 * Anthropic's published outbound IP range for MCP tool calls.
 * Source: https://docs.anthropic.com/en/api/ip-addresses
 * This range covers claude.ai and Claude Desktop outbound requests.
 * Anthropic commits to advance notice before changing these IPs.
 */
export const ANTHROPIC_CIDRS = ["160.79.104.0/21"];

/**
 * Additional allowed CIDR ranges (comma-separated).
 * Use to add personal IPs, VPN ranges, etc.
 * Example: "203.0.113.0/24,198.51.100.42/32"
 */
export const ALLOWED_CIDRS = process.env.ALLOWED_CIDRS
  ? process.env.ALLOWED_CIDRS.split(",").map(s => s.trim()).filter(Boolean)
  : [];

/**
 * When true, IP allowlisting is active.
 * Defaults to true — set to "false" to disable (e.g., local development).
 */
export const ENABLE_IP_ALLOWLIST = process.env.ENABLE_IP_ALLOWLIST !== "false";

/**
 * When true, prism_bootstrap drops a `.prism/trigger.yaml` marker into the
 * target project repo on first session if no marker is already present
 * (brief-105). Idempotent thereafter — bootstrap is a no-op when the marker
 * exists. Set to "false" or "0" to disable server-wide without editing
 * each project's marker file. Defaults to true.
 */
export const TRIGGER_AUTO_ENROLL =
  process.env.TRIGGER_AUTO_ENROLL !== "false" &&
  process.env.TRIGGER_AUTO_ENROLL !== "0";

/**
 * Stale-active threshold for prism_bootstrap surfacing (brief-416 / D-196
 * Piece 3). When the project's Trigger state file shows an `active` slot
 * with `execution_started_at` older than this and no `pr_created_at`, the
 * bootstrap response surfaces a warning + `STALE_ACTIVE_DETECTED` diagnostic
 * pointing the operator at INS-236.
 *
 * Default 30 minutes. Empirical grounding (state/prism-mcp-server.json
 * history): normal CC dispatch durations on this project ranged 5m 38s to
 * 13m 17s with a median of ~11.5m; historical wedges have been 1h 53m and
 * 2h 53m. 30 minutes sits comfortably above max-normal (13m 17s) and well
 * below wedge-floor (1h 53m), giving zero false positives on the historical
 * sample while still catching wedges within ~17m of the longest normal
 * completion. Override via Railway env-set without code change.
 */
export const STALE_ACTIVE_THRESHOLD_MS = Number(
  process.env.TRIGGER_STALE_ACTIVE_THRESHOLD_MS ?? 30 * 60 * 1000,
);

/**
 * Lookback window (ms) for boot-time synthesis observation surfacing
 * (brief-419 / Phase 3c-A). prism_bootstrap queries the prism-mcp-server's
 * own Railway production environment for warn-level logs and surfaces any
 * SYNTHESIS_TRANSPORT_FALLBACK / CS3_QUALITY_BYTE_COUNT_WARNING /
 * CS3_QUALITY_PREAMBLE_WARNING entry whose timestamp is strictly less than
 * this window in the past.
 *
 * Default 4 hours covers active-work sessions cleanly without false
 * positives from older finalizations when the operator returns after a
 * break. Override via Railway env-set without code change.
 */
export const SYNTHESIS_LOG_LOOKBACK_MS = Number(
  process.env.SYNTHESIS_LOG_LOOKBACK_MS ?? 4 * 60 * 60 * 1000,
);

if (!GITHUB_PAT) {
  console.error("FATAL: GITHUB_PAT environment variable is not set.");
  process.exit(1);
}
