/**
 * brief-s5 §3/§4/§5 — prism_bootstrap context_window contract.
 *
 * The client declares the one fact only it can know (its own model and
 * surface); the server owns the table. These tests pin three things the brief
 * treats as load-bearing:
 *
 *  1. BACKWARD COMPATIBILITY. With the new params absent, the response is
 *     byte-identical to today's apart from one additive key. That is asserted
 *     structurally (frozen key list) AND numerically — the measured payload
 *     size must not move at all, which is only true because context_window
 *     attaches POST-measurement alongside context_estimate.
 *  2. The env override becomes an ALARM rather than a silent winner. A silent
 *     override is exactly how a stale 200K value survived three model
 *     generations.
 *  3. Staleness is surfaced, not just computed.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
}));

import { fetchFile, fetchFiles, pushFile, fileExists } from "../src/github/client.js";
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from "../src/config.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBootstrap } from "../src/tools/bootstrap.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockFetchFiles = vi.mocked(fetchFiles);
const mockPushFile = vi.mocked(pushFile);
const mockFileExists = vi.mocked(fileExists);

let bootstrapHandler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

const mockServer = {
  tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => {
    if (name === "prism_bootstrap") bootstrapHandler = handler as typeof bootstrapHandler;
  }),
} as unknown as McpServer;

/** Capture the input schema too — the new params must be optional. */
let capturedSchema: Record<string, { isOptional?: () => boolean }> = {};
const schemaCaptureServer = {
  tool: vi.fn((name: string, _desc: string, schema: unknown, _handler: unknown) => {
    if (name === "prism_bootstrap") capturedSchema = schema as typeof capturedSchema;
  }),
} as unknown as McpServer;

const ENV_KEY = "DEFAULT_CONTEXT_WINDOW_TOKENS";
let savedEnv: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  registerBootstrap(mockServer);

  mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
    if (path === ".prism/handoff.md" || path === "handoff.md") {
      return {
        content: `# Handoff\n\n## Meta\n- Handoff Version: 33\n- Session Count: 28\n- Template Version: 2.10.0\n- Status: Active\n\n## Critical Context\n1. Item one\n2. Item two\n\n## Where We Are\nCurrent state.\n\n## Resumption Point\nResume here.\n\n## Next Steps\n1. Do thing A\n\n<!-- EOF: handoff.md -->`,
        sha: "abc123",
        size: 350,
      };
    }
    if (path === ".prism/decisions/_INDEX.md" || path === "decisions/_INDEX.md") {
      return {
        content: "| ID | Title | Domain | Status | Session |\n|---|---|---|---|---|\n| D-1 | Test | arch | SETTLED | 1 |\n\n<!-- EOF: _INDEX.md -->",
        sha: "def456",
        size: 120,
      };
    }
    if (path.includes("core-template-mcp.md")) {
      return {
        content: "# PRISM Core Template v2.10.0\nRules here.\n<!-- EOF: core-template-mcp.md -->",
        sha: "ghi789",
        size: 80,
      };
    }
    throw new Error(`not found: ${path}`);
  });
  mockFetchFiles.mockResolvedValue([]);
  // PushResult shape — `success` matters: pushBootTest propagates it to
  // boot_test_verified, and a mock omitting it drops the key from the payload.
  mockPushFile.mockResolvedValue({ success: true, sha: "pushed", commit_url: "https://github.com/x/y/commit/z" } as never);
  mockFileExists.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

async function boot(args: Record<string, unknown> = {}) {
  const res = await bootstrapHandler({ project_slug: "test-project", ...args });
  return JSON.parse(res.content[0].text);
}

// ─── §3 bootstrap contract ───────────────────────────────────────────

describe("prism_bootstrap — context_window contract", () => {
  it("declares client_model and client_surface as OPTIONAL params", () => {
    registerBootstrap(schemaCaptureServer);
    expect(capturedSchema.client_model).toBeDefined();
    expect(capturedSchema.client_surface).toBeDefined();
    expect(capturedSchema.client_model.isOptional?.()).toBe(true);
    expect(capturedSchema.client_surface.isOptional?.()).toBe(true);
    // The pre-existing params must not have become required/renamed.
    expect(capturedSchema.project_slug).toBeDefined();
    expect(capturedSchema.opening_message).toBeDefined();
  });

  it("resolves the declared model x surface and reports provenance", async () => {
    const r = await boot({ client_model: "claude-opus-5", client_surface: "chat" });
    expect(r.context_window.tokens).toBe(1_000_000);
    expect(r.context_window.source).toBe("documented");
    expect(r.context_window.matched).toBe("opus-5");
    expect(r.context_window.as_of).toBe("2026-07-31");
    expect(r.context_window.fallback_reason).toBeUndefined();
    expect(r.context_window.declared).toEqual({
      model: "claude-opus-5",
      surface: "chat",
      surface_defaulted: false,
    });
  });

  it("does NOT carry an API figure into the chat column (the S5 error)", async () => {
    const chat = await boot({ client_model: "claude-fable-5", client_surface: "chat" });
    expect(chat.context_window.tokens).toBe(200_000);
    expect(chat.context_window.source).toBe("undocumented_floor");

    const api = await boot({ client_model: "claude-fable-5", client_surface: "api" });
    expect(api.context_window.tokens).toBe(1_000_000);
    expect(api.context_window.source).toBe("documented");
  });

  it("defaults an undeclared surface to chat — the most conservative column — and discloses it", async () => {
    const r = await boot({ client_model: "claude-opus-4-6" });
    expect(r.context_window.declared.surface).toBe("chat");
    expect(r.context_window.declared.surface_defaulted).toBe(true);
    expect(r.context_window.tokens).toBe(500_000); // chat, not the 1M api figure
  });

  it("an unknown model degrades to a disclosed floor without failing the boot", async () => {
    const r = await boot({ client_model: "gpt-5", client_surface: "chat" });
    expect(r.context_window.tokens).toBe(200_000);
    expect(r.context_window.source).toBe("undocumented_floor");
    expect(r.context_window.fallback_reason).toContain("unknown_model");
    // Boot itself is unaffected.
    expect(r.project).toBe("test-project");
    expect(r.handoff_version).toBe(33);
  });

  it("reports boot cost against the RESOLVED window, which is the number S5 got wrong", async () => {
    const r = await boot({ client_model: "claude-opus-5", client_surface: "chat" });
    expect(r.context_window.total_boot_percent).toBe(
      Math.round((r.context_estimate.total_boot_tokens / 1_000_000) * 1000) / 10,
    );
    // Against a 1M window the same boot is a far smaller share than the 500K
    // legacy default implies — the phantom-budget failure, inverted.
    expect(r.context_window.total_boot_percent).toBeLessThan(r.context_estimate.total_boot_percent);
  });
});

// ─── backward compatibility ──────────────────────────────────────────

describe("backward compatibility — params absent", () => {
  /** Every top-level key the response carried before brief-s5, plus the one
   *  additive key. A new key appearing here is a deliberate contract change. */
  const EXPECTED_KEYS = [
    "project", "project_display_name", "handoff_version", "template_version",
    "session_count", "session_number", "session_timestamp", "session_name_line",
    "handoff_size_bytes", "scaling_required", "critical_context", "current_state",
    "resumption_point", "recent_decisions", "guardrails", "next_steps",
    "open_questions", "prefetched_documents", "standing_rules",
    // S208 PR-S2c: default BOOT_INDEX_MODE flipped full -> compact, so the
    // legacy standing_rules_index is absent under the default env this
    // suite boots with — session_state_manifest.rules.index is the surface.
    "session_state_manifest", "intelligence_brief",
    "brief_age_sessions", "behavioral_rules", "banner_text", "boot_masthead_svg",
    "boot_masthead_html", "banner_spec_version", "template_banner_spec_version",
    "boot_test_verified", "trigger_enrollment", "files_fetched",
    "expected_tool_surface", "post_boot_tool_searches",
    "recommended_session_settings", "autonomous_work_loop", "pdu_applied_at_boot",
    "warnings", "context_estimate", "response_bytes", "bytes_delivered",
    "diagnostics",
    "context_window", // ← the only brief-s5 addition
  ];

  it("adds exactly one top-level key and removes none", async () => {
    const r = await boot();
    expect(Object.keys(r).sort()).toEqual(EXPECTED_KEYS.sort());
  });

  it("reports the server config value tagged server_fallback", async () => {
    const r = await boot();
    expect(r.context_window.tokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(r.context_window.source).toBe("server_fallback");
    expect(r.context_window.matched).toBeNull();
    expect(r.context_window.as_of).toBeNull();
    expect(r.context_window.fallback_reason).toBeTruthy();
    expect(r.context_window.declared).toEqual({
      model: null,
      surface: null,
      surface_defaulted: false,
    });
  });

  it("the MEASURED payload is byte-identical whether or not the new params are sent", async () => {
    // context_window must attach post-measurement, exactly like
    // context_estimate — otherwise every existing size budget, tripwire
    // threshold and boot-cost figure shifts underneath the fleet.
    const legacy = await boot();
    const declared = await boot({ client_model: "claude-opus-5", client_surface: "chat" });
    expect(declared.context_estimate.bootstrap_tokens).toBe(legacy.context_estimate.bootstrap_tokens);
    expect(declared.response_bytes).toBe(legacy.response_bytes);
    expect(declared.bytes_delivered).toBe(legacy.bytes_delivered);
  });

  it("leaves the legacy context_estimate field untouched in both paths", async () => {
    const legacy = await boot();
    const declared = await boot({ client_model: "claude-opus-5", client_surface: "chat" });
    expect(legacy.context_estimate.context_window_tokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    // Declaring a model must NOT retarget the deprecated field — clients still
    // reading it keep reading exactly what they read yesterday.
    expect(declared.context_estimate).toEqual(legacy.context_estimate);
  });

  it("emits no context-window diagnostics on the legacy path", async () => {
    const r = await boot();
    const codes = (r.diagnostics as Array<{ code: string }>).map((d) => d.code);
    expect(codes).not.toContain("CONTEXT_WINDOW_OVERRIDE");
    expect(codes).not.toContain("CONTEXT_WINDOW_STALE");
  });
});

// ─── §4 the env override becomes an alarm ────────────────────────────

describe("§4 — a disagreeing env override is an alarm, not a silent winner", () => {
  it("warns when the override disagrees with the resolved cell, naming both values", async () => {
    process.env[ENV_KEY] = "200000";
    const r = await boot({ client_model: "claude-opus-5", client_surface: "chat" });
    const d = (r.diagnostics as Array<{ level: string; code: string; message: string; context: Record<string, unknown> }>)
      .find((x) => x.code === "CONTEXT_WINDOW_OVERRIDE");
    expect(d).toBeDefined();
    expect(d!.level).toBe("warn");
    expect(d!.message).toContain("200000");
    expect(d!.message).toContain("1000000");
    expect(d!.context.override_tokens).toBe(200_000);
    expect(d!.context.resolved_tokens).toBe(1_000_000);
    expect(d!.context.resolved_source).toBe("documented");
  });

  it("stays silent when the override agrees with the resolved cell", async () => {
    process.env[ENV_KEY] = "1000000";
    const r = await boot({ client_model: "claude-opus-5", client_surface: "chat" });
    const codes = (r.diagnostics as Array<{ code: string }>).map((d) => d.code);
    expect(codes).not.toContain("CONTEXT_WINDOW_OVERRIDE");
  });

  it("does not fire on the CODE default — the alarm is about the override only", async () => {
    delete process.env[ENV_KEY];
    // 500K code default vs a 1M resolved cell: a disagreement, but not an
    // override. Firing here would be permanent ambient noise.
    const r = await boot({ client_model: "claude-opus-5", client_surface: "chat" });
    const codes = (r.diagnostics as Array<{ code: string }>).map((d) => d.code);
    expect(codes).not.toContain("CONTEXT_WINDOW_OVERRIDE");
  });

  it("ignores an unparseable override rather than reporting NaN", async () => {
    process.env[ENV_KEY] = "not-a-number";
    const r = await boot({ client_model: "claude-opus-5", client_surface: "chat" });
    const codes = (r.diagnostics as Array<{ code: string }>).map((d) => d.code);
    expect(codes).not.toContain("CONTEXT_WINDOW_OVERRIDE");
  });

  it("the override never silently changes the resolved figure", async () => {
    process.env[ENV_KEY] = "200000";
    const r = await boot({ client_model: "claude-opus-5", client_surface: "chat" });
    expect(r.context_window.tokens).toBe(1_000_000);
    expect(r.context_window.override_tokens).toBe(200_000);
  });
});

// ─── §5 staleness surfaced ───────────────────────────────────────────

describe("§5 — staleness is surfaced, not just computed", () => {
  it("warns once a cell is past its provenance-specific threshold", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2027-06-01T00:00:00Z")); // ~305 days past seed
    const r = await boot({ client_model: "claude-opus-5", client_surface: "chat" });
    expect(r.context_window.stale).toBe(true);
    const d = (r.diagnostics as Array<{ level: string; code: string; context: Record<string, unknown> }>)
      .find((x) => x.code === "CONTEXT_WINDOW_STALE");
    expect(d).toBeDefined();
    expect(d!.level).toBe("warn");
    expect(d!.context.threshold_days).toBe(180);
    expect(d!.context.source).toBe("documented");
  });

  it("low-confidence cells trip the warning far sooner than documented ones", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-14T00:00:00Z")); // 45 days past seed
    const floorCell = await boot({ client_model: "claude-fable-5", client_surface: "chat" });
    expect(floorCell.context_window.stale).toBe(true);
    expect((floorCell.diagnostics as Array<{ code: string }>).map((d) => d.code))
      .toContain("CONTEXT_WINDOW_STALE");

    const documented = await boot({ client_model: "claude-opus-5", client_surface: "chat" });
    expect(documented.context_window.stale).toBe(false);
    expect((documented.diagnostics as Array<{ code: string }>).map((d) => d.code))
      .not.toContain("CONTEXT_WINDOW_STALE");
  });

  it("stays quiet at today's clock — a freshly seeded registry is not noisy", async () => {
    const r = await boot({ client_model: "claude-opus-5", client_surface: "chat" });
    expect(r.context_window.stale).toBe(false);
    expect((r.diagnostics as Array<{ code: string }>).map((d) => d.code))
      .not.toContain("CONTEXT_WINDOW_STALE");
  });
});
