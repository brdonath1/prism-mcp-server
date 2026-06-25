// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { SERVER_VERSION, VALID_COMMIT_PREFIXES } from "../src/config.js";
import { BANNER_SPEC_VERSION } from "../src/utils/banner.js";
import { TOOL_REGISTRY, type ToolCategory } from "../src/tool-registry.js";

/**
 * Brief-466 / W3-S7 — Task B (M-017) doc/version-discipline drift guards.
 * Each test fails if a documented claim drifts from code truth again.
 */

const claudeMd = readFileSync("CLAUDE.md", "utf-8");

describe("SRV-90 — SERVER_VERSION discipline", () => {
  function parseSemver(v: string): [number, number, number] {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) throw new Error(`unparseable version: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }

  it("satisfies the framework's >=4.7.1 floor", () => {
    const [maj, min, pat] = parseSemver(SERVER_VERSION);
    const ge = maj > 4 || (maj === 4 && (min > 7 || (min === 7 && pat >= 1)));
    expect(ge, `SERVER_VERSION ${SERVER_VERSION} must be >= 4.7.1`).toBe(true);
  });

  it("matches package.json version (kept in lockstep)", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
    expect(pkg.version).toBe(SERVER_VERSION);
  });

  it("CLAUDE.md architecture banner cites the current SERVER_VERSION", () => {
    expect(claudeMd).toContain(`v${SERVER_VERSION}`);
  });
});

describe("SRV-88 — banner-spec.md version matches code", () => {
  it("docs/banner-spec.md header version equals BANNER_SPEC_VERSION (or is marked superseded)", () => {
    const doc = readFileSync("docs/banner-spec.md", "utf-8");
    const declared = doc.match(/Banner-Spec-Version:\*\*\s*([0-9.]+)/)?.[1];
    const superseded = /superseded/i.test(doc);
    expect(declared === BANNER_SPEC_VERSION || superseded).toBe(true);
    // We did both: header is current AND it points at the real authority.
    expect(declared).toBe(BANNER_SPEC_VERSION);
  });
});

describe("SRV-92 — CLAUDE.md tool inventory matches TOOL_REGISTRY", () => {
  const counts = TOOL_REGISTRY.reduce<Record<ToolCategory, number>>(
    (acc, t) => ({ ...acc, [t.category]: (acc[t.category] ?? 0) + 1 }),
    {} as Record<ToolCategory, number>,
  );
  const total = TOOL_REGISTRY.length;

  it("total tool count is stated correctly", () => {
    expect(total).toBe(25); // tripwire: changing the surface must update CLAUDE.md
    expect(claudeMd).toContain(`${total} MCP tools`);
  });

  it("per-category counts are stated correctly", () => {
    expect(claudeMd).toContain(`${counts.prism_core} PRISM`);
    expect(claudeMd).toContain(`${counts.railway} Railway`);
    expect(claudeMd).toContain(`${counts.claude_code} Claude Code`);
    expect(claudeMd).toContain(`${counts.github} GitHub`);
  });
});

describe("SRV-93 — CLAUDE.md brief paths match .prism/trigger.yaml", () => {
  it("cites .prism/briefs/queue/ and no longer points at the non-existent docs/briefs/", () => {
    const trigger = readFileSync(".prism/trigger.yaml", "utf-8");
    expect(trigger).toContain("brief_dir: .prism/briefs/queue/");
    expect(claudeMd).toContain(".prism/briefs/queue/");
    expect(claudeMd).not.toContain("docs/briefs/");
  });
});

describe("SRV-94 — CLAUDE.md defers model identity to the registry", () => {
  it("does not hardcode a synthesis model name or an 'opus' default", () => {
    expect(claudeMd).toContain("src/models.ts");
    expect(claudeMd).not.toContain("Opus 4.8 for intelligence");
    expect(claudeMd).not.toMatch(/default:\s*`opus`/);
  });
});

describe("SRV-95 — .env.example documents synthesis env vars", () => {
  const envExample = readFileSync(".env.example", "utf-8");
  it("includes ANTHROPIC_API_KEY and the synthesis routing knobs", () => {
    expect(envExample).toContain("ANTHROPIC_API_KEY");
    expect(envExample).toContain("SYNTHESIS_BRIEF_TRANSPORT");
    expect(envExample).toContain("SYNTHESIS_PDU_MODEL");
  });

  it("documents LLM routing placeholders without secret-shaped examples", () => {
    expect(envExample).toContain("LLM_ROUTING_ENABLED=false");
    expect(envExample).toContain("LLM_ROUTING_DRY_RUN=true");
    expect(envExample).toContain("LLM_ROUTING_ALLOWED_PROVIDERS=anthropic");
    expect(envExample).toContain("LLM_ROUTING_CC_DISPATCH_PROVIDER=anthropic");
    expect(envExample).toContain("LLM_ROUTING_OPENAI_MODEL=gpt-5.5");
    expect(envExample).not.toMatch(/sk-|ghp_|xox|BEGIN .*PRIVATE/);
  });
});

describe("SRV-119 — LLM routing docs describe live synthesis activation", () => {
  const modelBump = readFileSync("docs/model-bump.md", "utf-8");

  it("CLAUDE.md documents sanitized live synthesis routing and cc_dispatch boundary", () => {
    expect(claudeMd).toContain("LLM_ROUTE_OBSERVATION");
    expect(claudeMd).toContain("can authorize live provider synthesis");
    expect(claudeMd).toContain("`cc_dispatch` remains Claude Code OAuth execution");
  });

  it("model-bump docs distinguish model bumps from multi-provider routing activation", () => {
    expect(modelBump).toContain("Multi-provider routing activation");
    expect(modelBump).toContain("LLM_ROUTING_ENABLED");
    expect(modelBump).toMatch(/fall back\s+to the existing Anthropic path/);
  });
});

describe("SRV-101 — prism_push schema description is rendered from VALID_COMMIT_PREFIXES", () => {
  const pushSrc = readFileSync("src/tools/push.ts", "utf-8");
  it("derives the prefix list from the constant (no hardcoded drift)", () => {
    expect(pushSrc).toContain("VALID_COMMIT_PREFIXES.join");
    expect(pushSrc).not.toContain("must start with prism:, fix:, docs:, or chore:");
  });
  it("VALID_COMMIT_PREFIXES includes audit: and test:", () => {
    expect(VALID_COMMIT_PREFIXES).toContain("audit:");
    expect(VALID_COMMIT_PREFIXES).toContain("test:");
  });
});
