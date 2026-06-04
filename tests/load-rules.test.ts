/**
 * Tests for prism_load_rules — D-156 §3.5 / Phase 2 PR 4 §3.6.
 *
 * Drives the registered tool handler directly via a minimal McpServer stub
 * (same pattern as tests/log-decision-dedup.test.ts) so we exercise the
 * full input-validation + diagnostics + matching pipeline without going
 * through HTTP transport.
 *
 * R2-B (D-240 Phase B): standing rules now resolve from a UNION of
 * `.prism/standing-rules.md` (the registry) and `insights.md` (legacy
 * location), dedup'd by INS-N with the registry winning on conflict. The
 * mock layer is path-aware so each test declares which source files exist.
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
 * Path-aware doc-resolver mock (R2-B). Declares which rule-source files
 * exist for the test: a `null`/omitted entry rejects like a 404, mirroring
 * the production resolveDocPath contract.
 */
function mockDocs(opts: {
  insights?: string | null;
  standingRules?: string | null;
}) {
  mockResolveDocPath.mockImplementation(async (_slug: string, docName: string) => {
    if (docName === "insights.md" && opts.insights != null) {
      return {
        path: ".prism/insights.md",
        content: opts.insights,
        sha: "ins-sha",
        legacy: false,
      };
    }
    if (docName === "standing-rules.md" && opts.standingRules != null) {
      return {
        path: ".prism/standing-rules.md",
        content: opts.standingRules,
        sha: "sr-sha",
        legacy: false,
      };
    }
    throw new Error(`404 not found: ${docName}`);
  });
}

interface RuleFixture {
  id: string;
  title: string;
  tier: "A" | "B" | "C";
  topics?: string[];
  procedure?: string;
}

/**
 * Build a synthetic rule-source body from a list of rule definitions. Each
 * rule is rendered as a `### INS-N: title — STANDING RULE [TIER:X]` section
 * with an optional `<!-- topics: ... -->` comment. Mirrors the production
 * shape that `extractStandingRules` parses — the parser is format-driven,
 * so the same builder serves insights.md and standing-rules.md fixtures.
 */
function buildRuleDoc(rules: RuleFixture[], eofName = "insights.md"): string {
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
    `<!-- EOF: ${eofName} -->`,
  ].join("\n");
}

const INSIGHTS_FIXTURE = buildRuleDoc([
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
    mockDocs({ insights: INSIGHTS_FIXTURE });

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
    mockDocs({ insights: INSIGHTS_FIXTURE });

    const handler = getHandler();
    const result = await handler({ project_slug: "prism", topic: "no_such_topic" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.matched_rules).toEqual([]);
    expect(payload.counts.tier_b_matched).toBe(0);
    const codes = payload.diagnostics.map((d: any) => d.code);
    expect(codes).toContain("STANDING_RULES_TOPICS_UNPOPULATED");
  });

  it("excludes Tier C when include_tier_c is false (default)", async () => {
    mockDocs({ insights: INSIGHTS_FIXTURE });

    const handler = getHandler();
    const result = await handler({ project_slug: "prism", topic: "synthesis" });
    const payload = JSON.parse(result.content[0].text);

    const ids = payload.matched_rules.map((r: any) => r.id);
    expect(ids).not.toContain("INS-20"); // Tier C — must be excluded
    expect(payload.counts.tier_c_matched).toBe(0);
  });

  it("includes Tier C when include_tier_c is true", async () => {
    mockDocs({ insights: INSIGHTS_FIXTURE });

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
    mockDocs({ insights: INSIGHTS_FIXTURE });

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

  it("returns empty result + INSIGHTS_FILE_NOT_FOUND diagnostic when no rule source exists", async () => {
    mockDocs({}); // neither insights.md nor standing-rules.md

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
    mockDocs({ insights: INSIGHTS_FIXTURE });

    const handler = getHandler();
    const result = await handler({ project_slug: "prism", topic: "Synthesis" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.topic).toBe("synthesis"); // normalized in the response
    expect(payload.matched_rules.map((r: any) => r.id)).toEqual(["INS-10"]);
  });
});

describe("prism_load_rules — R2-B standing-rules.md union read (D-240 Phase B)", () => {
  // (a) Only insights.md has rules — pre-migration projects must behave
  // exactly as before the registry existed.
  it("(a) resolves rules from insights.md alone when standing-rules.md is absent", async () => {
    mockDocs({ insights: INSIGHTS_FIXTURE });

    const handler = getHandler();
    const result = await handler({ project_slug: "prism", topic: "synthesis" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.matched_rules.map((r: any) => r.id)).toEqual(["INS-10"]);
    expect(payload.counts.total_standing_rules).toBe(6);
    expect(result.isError).toBeUndefined();
  });

  // (b1) Only standing-rules.md has rules; insights.md exists but holds none
  // (the post-R3-imm steady state).
  it("(b) resolves rules from standing-rules.md when insights.md has no rules", async () => {
    const registry = buildRuleDoc(
      [
        { id: "INS-40", title: "Registry-only rule", tier: "B", topics: ["synthesis"] },
        { id: "INS-41", title: "Registry tier A rule", tier: "A", topics: [] },
      ],
      "standing-rules.md",
    );
    const insightsWithoutRules =
      "# Insights\n\n## Active\n\n### INS-2: Plain insight\n- Category: pattern\n- Description: not a rule.\n\n## Formalized\n\n<!-- EOF: insights.md -->";

    mockDocs({ insights: insightsWithoutRules, standingRules: registry });

    const handler = getHandler();
    const result = await handler({ project_slug: "prism", topic: "synthesis" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.matched_rules.map((r: any) => r.id)).toEqual(["INS-40"]);
    expect(payload.counts.total_standing_rules).toBe(2);
    expect(payload.counts.tier_b_total).toBe(1);
    expect(payload.counts.tier_b_matched).toBe(1);
  });

  // (b2) standing-rules.md present, insights.md missing entirely — rules must
  // still resolve (insights.md absence is surfaced as a warning diagnostic,
  // not a dead end).
  it("(b) resolves rules from standing-rules.md when insights.md is missing entirely", async () => {
    const registry = buildRuleDoc(
      [{ id: "INS-40", title: "Registry-only rule", tier: "B", topics: ["synthesis"] }],
      "standing-rules.md",
    );
    mockDocs({ standingRules: registry });

    const handler = getHandler();
    const result = await handler({ project_slug: "prism", topic: "synthesis" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.matched_rules.map((r: any) => r.id)).toEqual(["INS-40"]);
    const codes = payload.diagnostics.map((d: any) => d.code);
    expect(codes).toContain("INSIGHTS_FILE_NOT_FOUND");
    expect(result.isError).toBeUndefined();
  });

  // (c) Both files contribute — the transient mid-migration state. The
  // delivered set is the union of both sources.
  it("(c) unions rules from both files when both have them", async () => {
    const registry = buildRuleDoc(
      [{ id: "INS-40", title: "Registry rule", tier: "B", topics: ["synthesis"] }],
      "standing-rules.md",
    );

    const handler = getHandler();
    mockDocs({ insights: INSIGHTS_FIXTURE, standingRules: registry });
    const result = await handler({ project_slug: "prism", topic: "synthesis" });
    const payload = JSON.parse(result.content[0].text);

    const ids = payload.matched_rules.map((r: any) => r.id).sort();
    expect(ids).toEqual(["INS-10", "INS-40"]);
    // 6 from insights + 1 registry-only.
    expect(payload.counts.total_standing_rules).toBe(7);
  });

  // (c) conflict: the same INS-N defined in both files — the registry
  // (standing-rules.md) version must win, and the conflict is surfaced.
  it("(c) prefers the standing-rules.md version on INS-N conflict", async () => {
    const registry = buildRuleDoc(
      [{
        id: "INS-10",
        title: "Synthesis cost guard (registry version)",
        tier: "B",
        topics: ["synthesis"],
        procedure: "Registry procedure wins.",
      }],
      "standing-rules.md",
    );

    const handler = getHandler();
    mockDocs({ insights: INSIGHTS_FIXTURE, standingRules: registry });
    const result = await handler({ project_slug: "prism", topic: "synthesis" });
    const payload = JSON.parse(result.content[0].text);

    const matches = payload.matched_rules.filter((r: any) => r.id === "INS-10");
    expect(matches).toHaveLength(1); // dedup'd — never delivered twice
    expect(matches[0].title).toBe("Synthesis cost guard (registry version)");
    // toContain (not toBe): the format-driven parser folds trailing
    // section-less lines (## Formalized / EOF sentinel) into the LAST rule's
    // procedure — pre-existing behavior, untouched by R2-B.
    expect(matches[0].procedure).toContain("Registry procedure wins.");
    expect(matches[0].procedure).not.toContain("Do the thing."); // insights version lost
    // Conflict is surfaced so the operator can finish the migration.
    const codes = payload.diagnostics.map((d: any) => d.code);
    expect(codes).toContain("STANDING_RULE_SOURCE_CONFLICT");
    // Union total: 6 insights rules, INS-10 replaced (not added) by registry.
    expect(payload.counts.total_standing_rules).toBe(6);
  });
});
