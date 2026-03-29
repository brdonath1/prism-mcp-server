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
export const SERVER_VERSION = "2.4.0";

/** GitHub API base URL */
export const GITHUB_API_BASE = "https://api.github.com";

/** Handoff size thresholds (bytes) */
export const HANDOFF_WARNING_SIZE = 10_240;   // 10 KB — needs-attention
export const HANDOFF_CRITICAL_SIZE = 15_360;  // 15 KB — scaling required

/** Summary mode threshold (bytes) */
export const SUMMARY_SIZE_THRESHOLD = 5_120;  // 5 KB

/** The 8 mandatory PRISM living documents */
export const LIVING_DOCUMENTS = [
  "handoff.md",
  "decisions/_INDEX.md",
  "session-log.md",
  "task-queue.md",
  "eliminated.md",
  "architecture.md",
  "glossary.md",
  "known-issues.md",
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

/** Keyword → living document mapping for bootstrap pre-fetching */
export const PREFETCH_KEYWORDS: Record<string, string> = {
  architecture: "architecture.md",
  stack: "architecture.md",
  infrastructure: "architecture.md",
  deploy: "architecture.md",
  integration: "architecture.md",
  bug: "known-issues.md",
  issue: "known-issues.md",
  error: "known-issues.md",
  workaround: "known-issues.md",
  debt: "known-issues.md",
  term: "glossary.md",
  definition: "glossary.md",
  glossary: "glossary.md",
  task: "task-queue.md",
  priority: "task-queue.md",
  next: "task-queue.md",
  queue: "task-queue.md",
  backlog: "task-queue.md",
  plan: "task-queue.md",
  reject: "eliminated.md",
  eliminate: "eliminated.md",
  guardrail: "eliminated.md",
  "why not": "eliminated.md",
  tried: "eliminated.md",
  session: "session-log.md",
  history: "session-log.md",
  "last time": "session-log.md",
  previous: "session-log.md",
};

if (!GITHUB_PAT) {
  console.error("FATAL: GITHUB_PAT environment variable is not set.");
  process.exit(1);
}
