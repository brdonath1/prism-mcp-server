/**
 * PRISM MCP Server configuration — loaded from environment variables.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

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

/** Server version. Bumped to 4.0.0 for Operations Gateway full stack (brief-104):
 *  server-side dedup for prism_log_decision, fetch path resolution, and the
 *  Claude Code orchestration layer (cc_dispatch + cc_status). */
export const SERVER_VERSION = "4.0.0";

/** MCP client timeout is ~60s. All server-side operations must complete within 50s
 *  to leave 10s buffer for transport overhead. This constrains synthesis, draft,
 *  and any long-running operations. */
export const MCP_SAFE_TIMEOUT = 50_000;

/** GitHub API base URL */
export const GITHUB_API_BASE = "https://api.github.com";

/** Handoff size thresholds (bytes) */
export const HANDOFF_WARNING_SIZE = 10_240;   // 10 KB — needs-attention
export const HANDOFF_CRITICAL_SIZE = 15_360;  // 15 KB — scaling required

/** Summary mode threshold (bytes) */
export const SUMMARY_SIZE_THRESHOLD = 5_120;  // 5 KB

/** Root directory for PRISM living documents within project repos (D-67) */
export const DOC_ROOT = ".prism";

/** Anthropic API key for Opus 4.6 synthesis (Track 2) */
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";

/** Model to use for synthesis */
export const SYNTHESIS_MODEL = process.env.SYNTHESIS_MODEL ?? "claude-opus-4-6";

/** Whether synthesis is enabled (requires API key) */
export const SYNTHESIS_ENABLED = !!process.env.ANTHROPIC_API_KEY;

/** Max output tokens for synthesis calls */
export const SYNTHESIS_MAX_OUTPUT_TOKENS = 4096;

/** Timeout for post-finalization synthesis (S34d). Separate from MCP_SAFE_TIMEOUT
 *  because synthesis runs after commit succeeds and is best-effort/non-fatal. */
export const SYNTHESIS_TIMEOUT_MS = 120_000;

/** Tool-level wall-clock deadline for prism_push (S40 C4). Hard backstop on
 *  top of the per-request GitHub fetch timeout. Configurable via env var so
 *  tests can inject a much smaller value without waiting 60s in CI. */
export const PUSH_WALL_CLOCK_DEADLINE_MS =
  parseInt(process.env.PUSH_WALL_CLOCK_DEADLINE_MS ?? "60000", 10) || 60_000;

/** Tool-level wall-clock deadline for prism_finalize commit phase (S40 C4).
 *  Longer than prism_push because commit has extra work — backup handoff,
 *  prune history, validate, doc-guard, then the atomic commit. */
export const FINALIZE_COMMIT_DEADLINE_MS =
  parseInt(process.env.FINALIZE_COMMIT_DEADLINE_MS ?? "90000", 10) || 90_000;

/** Per-call wall-clock budget (ms) for prism_patch (S63 Phase 1 Brief 3).
 *  Bounds the entire patch operation — fetch + N applyPatch + integrity
 *  validate + atomic commit (and any 409 retry the safeMutation primitive
 *  performs). Default 60s gives comfortable headroom over the per-request
 *  GitHub timeout (15s) for sequences that include retries, while staying
 *  below the MCP client's ~60s ceiling. Exceeding this deadline causes
 *  safeMutation to return `{ ok: false, code: "DEADLINE_EXCEEDED" }` and
 *  emit a DEADLINE_EXCEEDED diagnostic. Configurable via env var so tests
 *  can inject a much smaller value without waiting 60s in CI. */
export const PATCH_WALL_CLOCK_DEADLINE_MS =
  parseInt(process.env.PATCH_WALL_CLOCK_DEADLINE_MS ?? "60000", 10) || 60_000;

/** Per-attempt timeout for the Opus call inside prism_finalize draft phase.
 *  Accommodates large-project single-attempt latency (S41 — observed ~100s
 *  ceiling on PF-v2-scale inputs). Configurable via env for per-deployment
 *  tuning. */
export const FINALIZE_DRAFT_TIMEOUT_MS =
  parseInt(process.env.FINALIZE_DRAFT_TIMEOUT_MS ?? "150000", 10) || 150_000;

/** Tool-level wall-clock deadline for the prism_finalize draft phase (S41).
 *  Hard backstop on top of the per-attempt timeout — prevents any retry logic
 *  or unexpected blocking from holding the MCP client connection
 *  indefinitely. Mirrors FINALIZE_COMMIT_DEADLINE_MS pattern. */
export const FINALIZE_DRAFT_DEADLINE_MS =
  parseInt(process.env.FINALIZE_DRAFT_DEADLINE_MS ?? "180000", 10) || 180_000;

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
 *  Consumed by resolveDocPath(), resolveDocFiles(), and
 *  resolveDocFilesOptimized() — all of which prepend `.prism/` internally.
 *  Distinct from LIVING_DOCUMENTS (which is the prefixed form used when
 *  calling GitHub APIs directly without the resolver). Keep both in sync
 *  when adding or removing a living document. */
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
export const DISPLAY_NAME_TO_SLUG: Record<string, string> = Object.fromEntries(
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

/** MCP Auth Token for Bearer authentication (B.2) */
export const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";

/** Railway API token (workspace-scoped). Required to enable Railway tools. */
export const RAILWAY_API_TOKEN = process.env.RAILWAY_API_TOKEN ?? "";

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

/** Default model for Claude Code dispatch. "opus" resolves to the latest Opus. */
export const CC_DISPATCH_MODEL = process.env.CC_DISPATCH_MODEL ?? "opus";

/** Max turns for Claude Code dispatch (default). Can be overridden per-call. */
export const CC_DISPATCH_MAX_TURNS = parseInt(
  process.env.CC_DISPATCH_MAX_TURNS ?? "50",
  10,
);

/** Effort level for Claude Code dispatch.
 *  Controls reasoning depth via the Anthropic API effort parameter.
 *  Accepted values: "low", "medium", "high", "max".
 *  "max" is only supported on Claude Opus 4.6 — it enables the absolute
 *  highest reasoning capability with no constraints on token spending.
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
 * Root directory for dispatch state files in the prism-mcp-server repo.
 * Dispatch records are persisted to GitHub so cc_status can read them
 * across stateless server requests.
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

if (!GITHUB_PAT) {
  console.error("FATAL: GITHUB_PAT environment variable is not set.");
  process.exit(1);
}
