/**
 * Tests for prism_load_rules — D-156 §3.5 / Phase 2 PR 4 §3.6.
 *
 * Drives the registered tool handler directly via a minimal McpServer stub
 * (same pattern as tests/log-decision-dedup.test.ts) so we exercise the
 * full input-validation + diagnostics + matching pipeline without going
 * through HTTP transport.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocPath: vi.fn(),
  resolveDocPushPath: vi.fn(),
}));

import { registerLoadRules } from "../src/tools/load-rules.js";
import { resolveDocPath } from "../src/utils/doc-resolver.js";

const mockResolveDocPath = vi.mocked(resolveDocPath);

/**
 * Minimal McpServer stub that captures the registered handler so we can
 * invoke it directly. Mirrors the pattern in tests/log-decision-dedup.test.ts.
 */
function createServerStub() {
  const handlers: Record<string, Function> = {};
  const server = {
    tool(
      name: string,
      _description: string,
      _schema: unknown,
      handler: Function,
    ) {
      handlers[name] = handler;
    },
  };
  return { server, handlers };
}

/**
 * Build a synthetic insights.md body from a list of rule definitions. Each
 * rule is rendered as a `### INS-N: title — STANDING RULE [TIER:X]` section
 * with an optional `<!-- topics: ... -->` comment. Mirrors the production
 * shape that `extractStandingRules` parses.
 */
function buildInsights(rules: Array<{
  id: string;
  title: string;
  tier: "A" | "B" | "C";
  topics?: string[];
  procedure?: string;
}>): string {
  const sections = rules.map(r => {
    const tierTag = `[TIER:${r.tier}]`;
    const topicsLine = r.topics && r.topics.length > 0
      ? `\n<!-- topics: ${r.topics.join(", ")} -->\n`
      : "\n";
    const procedure = r.procedure ?? "Do the thing.";
    return [
      `### ${r.id}: ${r.title} — STANDING RULE ${tierTag}`,
      topicsLine,
      `**Standing procedure:** ${procedure}`,
      "",
    ].join("\n");
  });
  return [
    "# Insights",
    "",
    ...sections,
    "<!-- EOF: insights.md -->",
  ].join("\n");
}

const INSIGHTS_FIXTURE = buildInsights([
  // Tier A — must always be excluded by load_rules.
  { id: "INS-1", title: "Always-on judgment rule", tier: "A", topics: ["synthesis"] },
  // Tier B — matches "synthesis"
  { id: "INS-10", title: "Synthesis cost guard", tier: "B", topics: ["synthesis"] },
  // Tier B — different topic
  { id: "INS-11", title: "CC dispatch rule", tier: "B", topics: ["cc_dispatch"] },
  // Tier B — empty topics array (will never match — for unpopulated diagnostic)
  { id: "INS-12", title: "Empty-topics rule", tier: "B", topics: [] },
  // Tier C — matches "synthesis"
  { id: "INS-20", title: "Synthesis archival reference", tier: "C", topics: ["synthesis"] },
  // Tier C — different topic
  { id: "INS-21", title: "Trigger reference", tier: "C", topics: ["trigger"] },
]);

beforeEach(() => {
  vi.clearAllMocks();
});

function getHandler() {
  const { server, handlers } = createServerStub();
  registerLoadRules(server as any);
  const handler = handlers.prism_load_rules;
  if (!handler) throw new Error("prism_load_rules handler was not registered");
  return handler;
}

describe("prism_load_rules — registration + matching pipeline", () => {
  it("matches a single Tier B rule with populated topics array", async () => {
    mockResolveDocPath.mockResolvedValueOnce({
      path: ".prism/insights.md",
      content: INSIGHTS_FIXTURE,
      sha: "abc",
    } as any);

    const handler = getHandler();
    const result = await handler({ project_slug: "prism", topic: "synthesis" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.matched_rules.map((r: any) => r.id)).toEqual(["INS-10"]);
    expect(payload.counts.tier_b_matched).toBe(1);
    expect(payload.counts.tier_b_total).toBe(3);
    expect(payload.counts.tier_c_total).toBe(2);
    expect(payload.counts.tier_c_matched).toBe(0); // include_tier_c was false
  });

  it("emits STANDING_RULES_TOPICS_UNPOPULATED diagnostic when no Tier B rules match", async () => {
    mockResolveDocPath.mockResolvedValueOnce({
      path: ".prism/insights.md",
      content: INSIGHTS_FIXTURE,
      sha: "abc",
    } as any);

    const handler = getHandler();
    const result = await handler({ project_slug: "prism", topic: "no_such_topic" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.matched_rules).toEqual([]);
    expect(payload.counts.tier_b_matched).toBe(0);
    const codes = payload.diagnostics.map((d: any) => d.code);
    expect(codes).toContain("STANDING_RULES_TOPICS_UNPOPULATED");
  });

  it("excludes Tier C when include_tier_c is false (default)", async () => {
    mockResolveDocPath.mockResolvedValueOnce({
      path: ".prism/insights.md",
      content: INSIGHTS_FIXTURE,
      sha: "abc",
    } as any);

    const handler = getHandler();
    const result = await handler({ project_slug: "prism", topic: "synthesis" });
    const payload = JSON.parse(result.content[0].text);

    const ids = payload.matched_rules.map((r: any) => r.id);
    expect(ids).not.toContain("INS-20"); // Tier C — must be excluded
    expect(payload.counts.tier_c_matched).toBe(0);
  });

  it("includes Tier C when include_tier_c is true", async () => {
    mockResolveDocPath.mockResolvedValueOnce({
      path: ".prism/insights.md",
      content: INSIGHTS_FIXTURE,
      sha: "abc",
    } as any);

    const handler = getHandler();
    const result = await handler({
      project_slug: "prism",
      topic: "synthesis",
      include_tier_c: true,
    });
    const payload = JSON.parse(result.content[0].text);

    const ids = payload.matched_rules.map((r: any) => r.id).sort();
    expect(ids).toEqual(["INS-10", "INS-20"]);
    expect(payload.counts.tier_c_matched).toBe(1);
  });

  it("never includes Tier A rules even when their topics match", async () => {
    mockResolveDocPath.mockResolvedValueOnce({
      path: ".prism/insights.md",
      content: INSIGHTS_FIXTURE,
      sha: "abc",
    } as any);

    const handler = getHandler();
    const result = await handler({
      project_slug: "prism",
      topic: "synthesis",
      include_tier_c: true,
    });
    const payload = JSON.parse(result.content[0].text);

    const ids = payload.matched_rules.map((r: any) => r.id);
    expect(ids).not.toContain("INS-1"); // Tier A — must be excluded even though its topics match
  });

  it("returns empty result + INSIGHTS_FILE_NOT_FOUND diagnostic when insights.md is missing", async () => {
    mockResolveDocPath.mockRejectedValueOnce(new Error("404 not found"));

    const handler = getHandler();
    const result = await handler({ project_slug: "prism", topic: "synthesis" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.matched_rules).toEqual([]);
    expect(payload.counts.total_standing_rules).toBe(0);
    const codes = payload.diagnostics.map((d: any) => d.code);
    expect(codes).toContain("INSIGHTS_FILE_NOT_FOUND");
    // Tool must NOT mark this as an error response — empty result with diagnostic.
    expect(result.isError).toBeUndefined();
  });

  it("matches case-insensitively (topic 'Synthesis' matches rule with ['synthesis'])", async () => {
    mockResolveDocPath.mockResolvedValueOnce({
      path: ".prism/insights.md",
      content: INSIGHTS_FIXTURE,
      sha: "abc",
    } as any);

    const handler = getHandler();
    const result = await handler({ project_slug: "prism", topic: "Synthesis" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.topic).toBe("synthesis"); // normalized in the response
    expect(payload.matched_rules.map((r: any) => r.id)).toEqual(["INS-10"]);
  });
});
