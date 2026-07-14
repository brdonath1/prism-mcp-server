// brief-s202b T8 (D-275 F-1) — finalize compose-offload: validation-gate
// matrix (valid → draft_files + persisted state; invalid → legacy 6-key
// fallback + FINALIZE_COMPOSE_FALLBACK), FINALIZE_COMPOSE_MODE=legacy
// bit-identical behavior, summary clamp, and the review projection shape.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  composeDraftFiles,
  resolveDraftSummary,
  buildDraftFilesProjection,
  DRAFT_SUMMARY_MAX_BYTES,
} from "../src/tools/finalize.js";
import { FINALIZE_COMPOSE_HANDOFF_MAX_BYTES, FINALIZE_DRAFT_STATE_PATH } from "../src/config.js";

function validHandoffMd(opts: { version?: number; session?: number; itemBytes?: number; items?: number; pad?: number } = {}): string {
  const version = opts.version ?? 34;
  const session = opts.session ?? 29;
  const items = opts.items ?? 3;
  const itemText = "x".repeat(Math.max(10, (opts.itemBytes ?? 40) - 3));
  const itemLines = Array.from({ length: items }, (_, i) => `${i + 1}. ${itemText}`).join("\n");
  return [
    "# Handoff",
    "",
    "## Meta",
    `- Handoff Version: ${version}`,
    `- Session Count: ${session}`,
    "- Template Version: 2.29.0",
    "- Status: Active",
    "",
    "## Critical Context",
    itemLines,
    "",
    "## Where We Are",
    "Compose-offload landed; resume at the rollout checklist." + (opts.pad ? "\n" + "y".repeat(opts.pad) : ""),
    "",
    "## Next Steps",
    "1. Ship it",
    "",
    "<!-- EOF: handoff.md -->",
  ].join("\n");
}

const SESSION_LOG = `# Session Log

### Session 28
**Focus:** prior work.

<!-- EOF: session-log.md -->`;

const TASK_QUEUE = `# Task Queue

## Up Next
- [ ] Ship the compose offload

## Parking Lot

<!-- EOF: task-queue.md -->`;

function validDrafts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_log_entry: "### Session 29\n**Focus:** compose offload.\n**Key outcomes:**\n- landed",
    handoff_where_we_are: "Compose offload landed.",
    handoff_next_steps: ["Ship it"],
    handoff_session_history: "S29: compose offload",
    task_queue_completed: ["Ship the compose offload"],
    task_queue_new: ["[Up Next] Run the rollout checklist"],
    handoff_md: validHandoffMd(),
    draft_summary: "handoff v34: state updated | session-log: S29 entry | task-queue: 1 done, 1 added",
    ...overrides,
  };
}

// ─── composeDraftFiles — the quality gate (fallback trigger) ─────────────────

describe("brief-s202b T8 — composeDraftFiles validation-gate matrix", () => {
  it("valid draft → ok with handoff.md (from handoff_md) + bridged session-log.md + task-queue.md", () => {
    const outcome = composeDraftFiles(validDrafts(), { sessionLog: SESSION_LOG, taskQueue: TASK_QUEUE });
    expect(outcome.ok).toBe(true);
    const paths = outcome.files!.map(f => f.path);
    expect(paths).toEqual(["handoff.md", "session-log.md", "task-queue.md"]);
    const sessionLog = outcome.files!.find(f => f.path === "session-log.md")!.content;
    expect(sessionLog).toContain("### Session 29");
    expect(sessionLog).toContain("<!-- EOF: session-log.md -->");
    const taskQueue = outcome.files!.find(f => f.path === "task-queue.md")!.content;
    expect(taskQueue).toContain("- [x] Ship the compose offload");
    expect(taskQueue).toContain("- [ ] Run the rollout checklist");
  });

  it("missing handoff_md key → validation_failed fallback", () => {
    const drafts = validDrafts();
    delete drafts.handoff_md;
    const outcome = composeDraftFiles(drafts, { sessionLog: SESSION_LOG, taskQueue: TASK_QUEUE });
    expect(outcome.ok).toBe(false);
    expect(outcome.fallback_reason).toBe("validation_failed");
    expect(outcome.gate_failures![0].errors[0]).toContain("handoff_md");
  });

  it("handoff_md missing the schema (no ## Meta) → validation_failed with the validator's error", () => {
    const outcome = composeDraftFiles(
      validDrafts({ handoff_md: "# Handoff\nbroken\n<!-- EOF: handoff.md -->" }),
      { sessionLog: SESSION_LOG, taskQueue: TASK_QUEUE },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.fallback_reason).toBe("validation_failed");
    const handoffFailure = outcome.gate_failures!.find(g => g.path === "handoff.md")!;
    expect(handoffFailure.errors.some(e => e.includes("Meta"))).toBe(true);
  });

  it("handoff_md missing the EOF sentinel → validation_failed", () => {
    const outcome = composeDraftFiles(
      validDrafts({ handoff_md: validHandoffMd().replace("<!-- EOF: handoff.md -->", "") }),
      { sessionLog: SESSION_LOG, taskQueue: TASK_QUEUE },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.gate_failures!.some(g => g.errors.some(e => e.toLowerCase().includes("eof")))).toBe(true);
  });

  it("handoff_md over the 10KB compose size contract → validation_failed", () => {
    const outcome = composeDraftFiles(
      validDrafts({ handoff_md: validHandoffMd({ pad: FINALIZE_COMPOSE_HANDOFF_MAX_BYTES }) }),
      { sessionLog: SESSION_LOG, taskQueue: TASK_QUEUE },
    );
    expect(outcome.ok).toBe(false);
    expect(
      outcome.gate_failures!.some(g => g.errors.some(e => e.includes("compose size contract"))),
    ).toBe(true);
  });

  it("more than 5 Critical Context items → validation_failed (compose contract)", () => {
    const outcome = composeDraftFiles(
      validDrafts({ handoff_md: validHandoffMd({ items: 6 }) }),
      { sessionLog: SESSION_LOG, taskQueue: TASK_QUEUE },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.gate_failures!.some(g => g.errors.some(e => e.includes("caps at 5")))).toBe(true);
  });

  it("items over 300B are WARN-only (T5 calibration) — the gate still passes", () => {
    const outcome = composeDraftFiles(
      validDrafts({ handoff_md: validHandoffMd({ itemBytes: 400 }) }),
      { sessionLog: SESSION_LOG, taskQueue: TASK_QUEUE },
    );
    expect(outcome.ok).toBe(true);
    expect(
      outcome.warnings!.some(w => w.path === "handoff.md" && w.warnings.some(x => x.includes("HANDOFF_ITEM_OVERSIZE"))),
    ).toBe(true);
  });

  it("un-bridgeable session-log (fetch missing) does not fail the gate — the handoff alone composes", () => {
    const outcome = composeDraftFiles(validDrafts(), { taskQueue: TASK_QUEUE });
    expect(outcome.ok).toBe(true);
    expect(outcome.files!.map(f => f.path)).toEqual(["handoff.md", "task-queue.md"]);
    expect(outcome.bridge!.skipped.some(s => s.key === "session_log_entry")).toBe(true);
  });
});

// ─── resolveDraftSummary + projection ────────────────────────────────────────

describe("brief-s202b T8 — draft_summary clamp + draft_files projection", () => {
  it("clamps an over-1.5KB model summary to the byte budget", () => {
    const long = "s".repeat(4000);
    const clamped = resolveDraftSummary(validDrafts({ draft_summary: long }), [
      { path: "handoff.md", content: validHandoffMd() },
    ]);
    expect(new TextEncoder().encode(clamped).length).toBeLessThanOrEqual(DRAFT_SUMMARY_MAX_BYTES);
    expect(clamped.endsWith("…")).toBe(true);
  });

  it("builds a deterministic server-side digest when the model omitted draft_summary", () => {
    const drafts = validDrafts({ draft_summary: undefined });
    const summary = resolveDraftSummary(drafts, [{ path: "handoff.md", content: validHandoffMd() }]);
    expect(summary).toContain("handoff.md composed");
    expect(summary).toContain("1 completed, 1 added");
  });

  it("projection: handoff ships FULL, session-log/task-queue ship DELTAS with true full_bytes", () => {
    const drafts = validDrafts();
    const compose = composeDraftFiles(drafts, { sessionLog: SESSION_LOG, taskQueue: TASK_QUEUE });
    const projection = buildDraftFilesProjection(drafts, compose.files!);

    const handoff = projection.find(p => p.path === "handoff.md")!;
    expect(handoff.delivery).toBe("full");
    expect(handoff.content).toBe(drafts.handoff_md);

    const sessionLog = projection.find(p => p.path === "session-log.md")!;
    expect(sessionLog.delivery).toBe("delta");
    expect(sessionLog.content).toBe(drafts.session_log_entry);
    const composedLog = compose.files!.find(f => f.path === "session-log.md")!.content;
    expect(sessionLog.full_bytes).toBe(new TextEncoder().encode(composedLog).length);
    expect(sessionLog.content.length).toBeLessThan(composedLog.length);

    const taskQueue = projection.find(p => p.path === "task-queue.md")!;
    expect(taskQueue.delivery).toBe("delta");
    expect(taskQueue.content).toContain("[x] Ship the compose offload");
    expect(taskQueue.content).toContain("[+] [Up Next] Run the rollout checklist");
  });
});

// ─── draftPhase integration (action=draft through the tool handler) ─────────

describe("brief-s202b T8 — action=draft compose-offload integration", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ["FINALIZE_COMPOSE_MODE", "ANTHROPIC_API_KEY", "SYNTHESIS_DRAFT_TRANSPORT"] as const;

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    delete process.env.SYNTHESIS_DRAFT_TRANSPORT;
    process.env.ANTHROPIC_API_KEY = "test-dummy-key";
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.resetModules();
    vi.doUnmock("../src/ai/client.js");
    vi.doUnmock("../src/github/client.js");
    vi.doUnmock("../src/utils/doc-resolver.js");
  });

  function buildMockExtra(requestId: string) {
    return {
      signal: new AbortController().signal,
      _meta: undefined,
      requestId,
      sendNotification: vi.fn().mockResolvedValue(undefined),
      sendRequest: vi.fn().mockResolvedValue(undefined),
    };
  }

  async function runDraft(modelJson: Record<string, unknown>) {
    vi.resetModules();

    const synthesizeSpy = vi.fn().mockResolvedValue({
      success: true,
      content: JSON.stringify(modelJson),
      input_tokens: 100,
      output_tokens: 900,
      model: "test-model",
    });
    const pushFileSpy = vi.fn().mockResolvedValue({ success: true, sha: "persist-sha", size: 1 });

    vi.doMock("../src/ai/client.js", () => ({ synthesize: synthesizeSpy }));
    vi.doMock("../src/github/client.js", () => ({
      fetchFile: vi.fn(),
      fetchFiles: vi.fn(),
      pushFile: pushFileSpy,
      listDirectory: vi.fn().mockResolvedValue([]),
      listCommits: vi.fn().mockResolvedValue([]),
      getCommit: vi.fn(),
      deleteFile: vi.fn(),
      fileExists: vi.fn(),
      createAtomicCommit: vi.fn(),
      getHeadSha: vi.fn(),
      getDefaultBranch: vi.fn(),
    }));
    vi.doMock("../src/utils/doc-resolver.js", () => ({
      resolveDocPath: vi.fn(),
      resolveDocPushPath: vi.fn(),
      resolveDocFiles: vi.fn().mockResolvedValue(
        new Map([
          ["handoff.md", { content: validHandoffMd({ version: 33, session: 28 }), sha: "h", size: 100 }],
          ["session-log.md", { content: SESSION_LOG, sha: "s", size: SESSION_LOG.length }],
          ["task-queue.md", { content: TASK_QUEUE, sha: "t", size: TASK_QUEUE.length }],
        ]),
      ),
    }));

    const { registerFinalize } = await import("../src/tools/finalize.js");
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
    registerFinalize(server);
    const tool = (server as any)._registeredTools["prism_finalize"];
    const result = await tool.handler(
      { project_slug: "test-project", action: "draft", session_number: 29 },
      buildMockExtra("compose-1"),
    );
    return { parsed: JSON.parse(result.content[0].text), synthesizeSpy, pushFileSpy };
  }

  it("valid model output → draft_files + draft_summary returned, legacy drafts stripped, state persisted", async () => {
    delete process.env.FINALIZE_COMPOSE_MODE;
    // The fixture handoff is v33 → the compose prompt/state target v34.
    const { parsed, synthesizeSpy, pushFileSpy } = await runDraft(validDrafts({ handoff_md: validHandoffMd({ version: 34, session: 29 }) }));

    expect(parsed.success).toBe(true);
    expect(parsed.compose_mode).toBe("files");
    expect(parsed.drafts).toBeUndefined(); // stripped from the RESPONSE (review surface is draft_files + summary)
    expect(parsed.draft_files.map((f: { path: string }) => f.path)).toEqual([
      "handoff.md",
      "session-log.md",
      "task-queue.md",
    ]);
    expect(parsed.draft_summary.length).toBeGreaterThan(0);
    expect(parsed.handoff_version).toBe(34);
    expect(parsed.review_instructions).toContain("use_draft_files");

    // The compose prompt (not the legacy one) went to the model, with the
    // wider output budget.
    expect(synthesizeSpy.mock.calls[0][0]).toContain("HANDOFF FILE CONTRACT");
    expect(synthesizeSpy.mock.calls[0][2]).toBe(8192);

    // Persisted state: one pushFile to the draft-state path with the FULL files.
    const persistCall = pushFileSpy.mock.calls.find((c: unknown[]) => c[1] === FINALIZE_DRAFT_STATE_PATH);
    expect(persistCall).toBeDefined();
    const state = JSON.parse(persistCall![2] as string);
    expect(state.session_number).toBe(29);
    expect(state.handoff_version).toBe(34);
    expect(state.files.map((f: { path: string }) => f.path)).toEqual([
      "handoff.md",
      "session-log.md",
      "task-queue.md",
    ]);
    expect(persistCall![3]).toMatch(/^prism: /); // valid commit prefix
  });

  it("invalid model handoff → legacy 6-key response + FINALIZE_COMPOSE_FALLBACK warn, nothing persisted", async () => {
    delete process.env.FINALIZE_COMPOSE_MODE;
    const { parsed, pushFileSpy } = await runDraft(
      validDrafts({ handoff_md: "# Handoff\nno schema here\n<!-- EOF: handoff.md -->" }),
    );

    expect(parsed.success).toBe(true);
    expect(parsed.compose_mode).toBeUndefined();
    expect(parsed.drafts).toBeDefined(); // legacy response shape
    expect(parsed.draft_files).toBeUndefined();
    const fallback = (parsed.diagnostics as Array<{ code: string; level: string; context?: { fallback_reason?: string } }>).find(
      d => d.code === "FINALIZE_COMPOSE_FALLBACK",
    );
    expect(fallback).toBeDefined();
    expect(fallback!.level).toBe("warn");
    expect(fallback!.context!.fallback_reason).toBe("validation_failed");
    expect(pushFileSpy.mock.calls.some((c: unknown[]) => c[1] === FINALIZE_DRAFT_STATE_PATH)).toBe(false);
  });

  it("FINALIZE_COMPOSE_MODE=legacy → today's exact draft behavior (legacy prompt, 4096 budget, no persistence)", async () => {
    process.env.FINALIZE_COMPOSE_MODE = "legacy";
    const { parsed, synthesizeSpy, pushFileSpy } = await runDraft(validDrafts());

    expect(parsed.success).toBe(true);
    expect(parsed.drafts).toBeDefined();
    expect(parsed.draft_files).toBeUndefined();
    expect(parsed.compose_mode).toBeUndefined();
    expect(synthesizeSpy.mock.calls[0][0]).not.toContain("HANDOFF FILE CONTRACT");
    expect(synthesizeSpy.mock.calls[0][2]).toBe(4096);
    expect(pushFileSpy.mock.calls.some((c: unknown[]) => c[1] === FINALIZE_DRAFT_STATE_PATH)).toBe(false);
  });

  it("persist failure → legacy 6-key response + FINALIZE_COMPOSE_FALLBACK(persist_failed)", async () => {
    delete process.env.FINALIZE_COMPOSE_MODE;
    vi.resetModules();

    const synthesizeSpy = vi.fn().mockResolvedValue({
      success: true,
      content: JSON.stringify(validDrafts({ handoff_md: validHandoffMd({ version: 34, session: 29 }) })),
      input_tokens: 100,
      output_tokens: 900,
      model: "test-model",
    });
    const pushFileSpy = vi.fn().mockResolvedValue({ success: false, error: "409 conflict" });

    vi.doMock("../src/ai/client.js", () => ({ synthesize: synthesizeSpy }));
    vi.doMock("../src/github/client.js", () => ({
      fetchFile: vi.fn(),
      fetchFiles: vi.fn(),
      pushFile: pushFileSpy,
      listDirectory: vi.fn().mockResolvedValue([]),
      listCommits: vi.fn().mockResolvedValue([]),
      getCommit: vi.fn(),
      deleteFile: vi.fn(),
      fileExists: vi.fn(),
      createAtomicCommit: vi.fn(),
      getHeadSha: vi.fn(),
      getDefaultBranch: vi.fn(),
    }));
    vi.doMock("../src/utils/doc-resolver.js", () => ({
      resolveDocPath: vi.fn(),
      resolveDocPushPath: vi.fn(),
      resolveDocFiles: vi.fn().mockResolvedValue(
        new Map([
          ["handoff.md", { content: validHandoffMd({ version: 33, session: 28 }), sha: "h", size: 100 }],
          ["session-log.md", { content: SESSION_LOG, sha: "s", size: SESSION_LOG.length }],
          ["task-queue.md", { content: TASK_QUEUE, sha: "t", size: TASK_QUEUE.length }],
        ]),
      ),
    }));

    const { registerFinalize } = await import("../src/tools/finalize.js");
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
    registerFinalize(server);
    const tool = (server as any)._registeredTools["prism_finalize"];
    const result = await tool.handler(
      { project_slug: "test-project", action: "draft", session_number: 29 },
      buildMockExtra("compose-2"),
    );
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.success).toBe(true);
    expect(parsed.drafts).toBeDefined();
    expect(parsed.draft_files).toBeUndefined();
    const fallback = (parsed.diagnostics as Array<{ code: string; context?: { fallback_reason?: string } }>).find(
      d => d.code === "FINALIZE_COMPOSE_FALLBACK",
    );
    expect(fallback).toBeDefined();
    expect(fallback!.context!.fallback_reason).toBe("persist_failed");
  });
});
