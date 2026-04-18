/**
 * tool-surface.test.ts — D-83 guard rails.
 *
 * Per INS-31, HTTP-routing tests must mock fetch. These tests verify registry
 * shape, feature-flag gating, and source-level wiring — not HTTP behavior —
 * so readFileSync-based source checks are acceptable and intentional here.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  TOOL_REGISTRY,
  getExpectedToolSurface,
  POST_BOOT_TOOL_SEARCHES,
  type ToolCategory,
} from "../src/tool-registry.js";

describe("D-83 — TOOL_REGISTRY shape", () => {
  it("contains exactly 18 tools", () => {
    expect(TOOL_REGISTRY).toHaveLength(18);
  });

  it("categorizes 12 prism_core, 4 railway, 2 claude_code", () => {
    const counts: Record<ToolCategory, number> = {
      prism_core: 0,
      railway: 0,
      claude_code: 0,
    };
    for (const t of TOOL_REGISTRY) counts[t.category]++;
    expect(counts).toEqual({ prism_core: 12, railway: 4, claude_code: 2 });
  });

  it("has unique tool names", () => {
    const names = TOOL_REGISTRY.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("D-83 — getExpectedToolSurface() feature-flag gating", () => {
  it("returns all 18 tools when both flags enabled", () => {
    const surface = getExpectedToolSurface(true, true);
    expect(surface.prism_core).toHaveLength(12);
    expect(surface.railway).toHaveLength(4);
    expect(surface.claude_code).toHaveLength(2);
    const flat = [...surface.prism_core, ...surface.railway, ...surface.claude_code];
    expect(flat).toEqual(TOOL_REGISTRY.map((t) => t.name));
  });

  it("excludes railway when RAILWAY_ENABLED=false", () => {
    const surface = getExpectedToolSurface(false, true);
    expect(surface.railway).toEqual([]);
    expect(surface.prism_core).toHaveLength(12);
    expect(surface.claude_code).toHaveLength(2);
  });

  it("excludes claude_code when CC_DISPATCH_ENABLED=false", () => {
    const surface = getExpectedToolSurface(true, false);
    expect(surface.claude_code).toEqual([]);
    expect(surface.prism_core).toHaveLength(12);
    expect(surface.railway).toHaveLength(4);
  });

  it("returns only prism_core when both optional flags disabled", () => {
    const surface = getExpectedToolSurface(false, false);
    expect(surface.prism_core).toHaveLength(12);
    expect(surface.railway).toEqual([]);
    expect(surface.claude_code).toEqual([]);
  });
});

describe("D-83 — drift guard: src/index.ts registers every TOOL_REGISTRY entry", () => {
  // Tool name -> register function name mapping.
  // If TOOL_REGISTRY names deviate from the register* naming convention, update here.
  const REGISTER_FN_BY_TOOL: Record<string, string> = {
    prism_bootstrap: "registerBootstrap",
    prism_fetch: "registerFetch",
    prism_push: "registerPush",
    prism_status: "registerStatus",
    prism_finalize: "registerFinalize",
    prism_analytics: "registerAnalytics",
    prism_scale_handoff: "registerScaleHandoff",
    prism_search: "registerSearch",
    prism_synthesize: "registerSynthesize",
    prism_log_decision: "registerLogDecision",
    prism_log_insight: "registerLogInsight",
    prism_patch: "registerPatch",
    railway_logs: "registerRailwayLogs",
    railway_deploy: "registerRailwayDeploy",
    railway_env: "registerRailwayEnv",
    railway_status: "registerRailwayStatus",
    cc_dispatch: "registerCCDispatch",
    cc_status: "registerCCStatus",
  };

  const indexSource = readFileSync("src/index.ts", "utf-8");

  it.each(TOOL_REGISTRY.map((t) => [t.name]))(
    "%s has a matching register*() call in src/index.ts",
    (toolName) => {
      const registerFn = REGISTER_FN_BY_TOOL[toolName];
      expect(registerFn, `No REGISTER_FN_BY_TOOL mapping for ${toolName} — update this test`).toBeDefined();
      expect(indexSource).toContain(`${registerFn}(server)`);
    },
  );

  it("REGISTER_FN_BY_TOOL covers every tool (no missing mappings)", () => {
    const missing = TOOL_REGISTRY.filter((t) => !REGISTER_FN_BY_TOOL[t.name]);
    expect(missing).toEqual([]);
  });
});

describe("D-83 — coverage guard: every tool has keyword overlap with POST_BOOT_TOOL_SEARCHES", () => {
  it("every tool shares at least one token with at least one query", () => {
    const queryTokens = new Set(
      POST_BOOT_TOOL_SEARCHES.flatMap((q) =>
        q.query.toLowerCase().split(/\s+/).filter((t) => t.length > 0),
      ),
    );

    const gaps: string[] = [];
    for (const tool of TOOL_REGISTRY) {
      const toolTokens = tool.name.toLowerCase().split("_");
      const hasOverlap = toolTokens.some((tt) =>
        Array.from(queryTokens).some((qt) => qt === tt || qt.includes(tt) || tt.includes(qt)),
      );
      if (!hasOverlap) gaps.push(tool.name);
    }

    expect(
      gaps,
      `Tools with no keyword overlap in POST_BOOT_TOOL_SEARCHES: ${gaps.join(", ")}. ` +
        `Either add a keyword to one of the queries or rename the tool.`,
    ).toEqual([]);
  });

  it("POST_BOOT_TOOL_SEARCHES has exactly 2 queries (S43 empirical)", () => {
    expect(POST_BOOT_TOOL_SEARCHES).toHaveLength(2);
  });

  it("every query has limit >= 15 (defeats relevance-ranking cap)", () => {
    for (const q of POST_BOOT_TOOL_SEARCHES) {
      expect(q.limit).toBeGreaterThanOrEqual(15);
    }
  });
});

describe("D-83 — bootstrap response wiring (source-read)", () => {
  const bootstrapSource = readFileSync("src/tools/bootstrap.ts", "utf-8");

  it("imports getExpectedToolSurface and POST_BOOT_TOOL_SEARCHES from ../tool-registry.js", () => {
    expect(bootstrapSource).toMatch(
      /import\s*\{[^}]*getExpectedToolSurface[^}]*\}\s*from\s*["']\.\.\/tool-registry\.js["']/,
    );
    expect(bootstrapSource).toMatch(
      /import\s*\{[^}]*POST_BOOT_TOOL_SEARCHES[^}]*\}\s*from\s*["']\.\.\/tool-registry\.js["']/,
    );
  });

  it("imports RAILWAY_ENABLED and CC_DISPATCH_ENABLED from ../config.js", () => {
    expect(bootstrapSource).toMatch(/import\s*\{[^}]*RAILWAY_ENABLED[^}]*\}\s*from\s*["']\.\.\/config\.js["']/);
    expect(bootstrapSource).toMatch(/import\s*\{[^}]*CC_DISPATCH_ENABLED[^}]*\}\s*from\s*["']\.\.\/config\.js["']/);
  });

  it("response object includes expected_tool_surface field wired to getExpectedToolSurface(RAILWAY_ENABLED, CC_DISPATCH_ENABLED)", () => {
    expect(bootstrapSource).toContain(
      "expected_tool_surface: getExpectedToolSurface(RAILWAY_ENABLED, CC_DISPATCH_ENABLED)",
    );
  });

  it("response object includes post_boot_tool_searches field wired to POST_BOOT_TOOL_SEARCHES", () => {
    expect(bootstrapSource).toContain("post_boot_tool_searches: POST_BOOT_TOOL_SEARCHES");
  });
});
