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

/** Server version */
export const SERVER_VERSION = "2.12.0";

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

/** Legacy paths (pre-D-67 consolidation) for backward compatibility.
 *  Used by resolveDocPath() to find files in repos not yet migrated.
 *  REMOVE after all repos confirmed migrated to .prism/ structure. */
export const LEGACY_LIVING_DOCUMENTS = [
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
export const VALID_COMMIT_PREFIXES = ["prism:", "fix:", "docs:", "chore:"] as const;

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
