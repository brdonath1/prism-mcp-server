/**
 * Tool registry — single source of truth for the PRISM MCP tool surface.
 *
 * D-83 (S44): This file powers two things:
 *  1. The `expected_tool_surface` and `post_boot_tool_searches` fields in
 *     the prism_bootstrap response (src/tools/bootstrap.ts).
 *  2. The drift-guard tests in tests/tool-surface.test.ts that verify the
 *     registry matches what src/index.ts actually registers.
 *
 * When adding a new tool: update TOOL_REGISTRY here, register it in
 * src/index.ts, and (if it doesn't already match an existing query's
 * keywords) extend POST_BOOT_TOOL_SEARCHES so Claude's client-side
 * tool_search surfaces it during boot. The coverage test in
 * tests/tool-surface.test.ts will fail if a tool is added without
 * corresponding keyword coverage.
 */

export type ToolCategory = "prism_core" | "railway" | "claude_code";

export interface ToolRegistryEntry {
  name: string;
  category: ToolCategory;
}

/**
 * All tools registered by the MCP server, in registration order.
 * Mirrors the register*() call order in src/index.ts.
 *
 * Category `prism_core` = always registered.
 * Category `railway` = registered only when RAILWAY_ENABLED.
 * Category `claude_code` = registered only when CC_DISPATCH_ENABLED.
 */
export const TOOL_REGISTRY: readonly ToolRegistryEntry[] = [
  // PRISM core (13)
  { name: "prism_bootstrap", category: "prism_core" },
  { name: "prism_fetch", category: "prism_core" },
  { name: "prism_push", category: "prism_core" },
  { name: "prism_status", category: "prism_core" },
  { name: "prism_finalize", category: "prism_core" },
  { name: "prism_analytics", category: "prism_core" },
  { name: "prism_scale_handoff", category: "prism_core" },
  { name: "prism_search", category: "prism_core" },
  { name: "prism_synthesize", category: "prism_core" },
  { name: "prism_log_decision", category: "prism_core" },
  { name: "prism_log_insight", category: "prism_core" },
  { name: "prism_patch", category: "prism_core" },
  { name: "prism_load_rules", category: "prism_core" },
  // Railway (4)
  { name: "railway_logs", category: "railway" },
  { name: "railway_deploy", category: "railway" },
  { name: "railway_env", category: "railway" },
  { name: "railway_status", category: "railway" },
  // Claude Code (2)
  { name: "cc_dispatch", category: "claude_code" },
  { name: "cc_status", category: "claude_code" },
] as const;

/**
 * Derive the expected tool surface by category, respecting feature flags.
 * Returned shape is suitable for direct inclusion in the bootstrap response.
 */
export function getExpectedToolSurface(
  railwayEnabled: boolean,
  ccDispatchEnabled: boolean,
): Record<ToolCategory, string[]> {
  const filterByCategory = (cat: ToolCategory) =>
    TOOL_REGISTRY.filter((t) => t.category === cat).map((t) => t.name);

  return {
    prism_core: filterByCategory("prism_core"),
    railway: railwayEnabled ? filterByCategory("railway") : [],
    claude_code: ccDispatchEnabled ? filterByCategory("claude_code") : [],
  };
}

/**
 * Post-boot tool_search queries that Claude executes after receiving the
 * bootstrap response. Together these two queries empirically load all 18
 * registered tools (verified live S43). Each query's limit is intentionally
 * set to 20 to defeat the relevance-ranking cap that causes
 * `tool_search("prism", limit=20)` to still return only 7 results.
 *
 * When adding a new tool: verify at least one of these queries contains a
 * keyword that matches the tool's name or description. The coverage test
 * in tests/tool-surface.test.ts enforces this.
 */
export interface PostBootToolSearch {
  query: string;
  limit: number;
}

export const POST_BOOT_TOOL_SEARCHES: readonly PostBootToolSearch[] = [
  { query: "prism log patch scale synthesize analytics finalize", limit: 20 },
  { query: "railway deploy environment status dispatch claude code", limit: 20 },
] as const;
