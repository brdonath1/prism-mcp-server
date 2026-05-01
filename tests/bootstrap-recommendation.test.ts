// brief-411 / D-193 Piece 1 — bootstrap reads the persisted recommendation
// from handoff.md instead of reclassifying with divergent inputs.
//
// The S107→S108 banner discrepancy was caused by bootstrap classifying with
// `next_steps + critical_context + opening_message` while finalize used
// `next_steps` only. After brief-411, bootstrap parses the block written by
// finalize. Back-compat fallback (handoff missing the block) must classify
// on `next_steps` only — NOT on critical_context or opening_message — so
// the fallback verdict matches what finalize WOULD have produced.

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
  listRepos: vi.fn(),
}));

interface CapturedHandler {
  (args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

const PERSISTED_BLOCK_EXECUTIONAL = `## Recommended Session Settings

<!-- prism:recommended_session_settings -->
- Model: Sonnet 4.6
- Thinking: Adaptive off
- Category: executional
- Rationale: Queue is mechanical cleanup / patches
<!-- /prism:recommended_session_settings -->`;

const DECISIONS_CONTENT =
  "| ID | Title | Domain | Status | Session |\n" +
  "|---|---|---|---|---|\n" +
  "| D-1 | Test | arch | SETTLED | 1 |\n\n" +
  "<!-- EOF: _INDEX.md -->";

const TEMPLATE_CONTENT =
  "# Template v2.16.0\nRules.\n<!-- EOF: core-template-mcp.md -->";

function buildHandoff(opts: {
  withPersistedBlock?: boolean;
  persistedBlock?: string;
  nextSteps: string[];
  criticalContext: string[];
}): string {
  const ncLines = opts.criticalContext.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const nsLines = opts.nextSteps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const persistedSection = opts.withPersistedBlock
    ? `\n${opts.persistedBlock ?? PERSISTED_BLOCK_EXECUTIONAL}\n`
    : "";

  return `# Handoff

## Meta
- Handoff Version: 113
- Session Count: 108
- Template Version: 2.16.0
- Status: Active
${persistedSection}
## Critical Context
${ncLines}

## Where We Are
Working.

## Resumption Point
Pick up.

## Next Steps
${nsLines}

<!-- EOF: handoff.md -->`;
}

function makeFetchFileMock(handoffContent: string) {
  return (_repo: string, path: string) => {
    if (path === ".prism/trigger.yaml") {
      // Marker present so we don't push during these tests.
      return Promise.resolve({
        content: "enabled: false\n",
        sha: "marker-sha",
        size: 20,
      });
    }
    if (path.endsWith("handoff.md")) {
      return Promise.resolve({
        content: handoffContent,
        sha: "h1",
        size: handoffContent.length,
      });
    }
    if (path.endsWith("decisions/_INDEX.md")) {
      return Promise.resolve({
        content: DECISIONS_CONTENT,
        sha: "d1",
        size: DECISIONS_CONTENT.length,
      });
    }
    if (path.includes("core-template-mcp.md")) {
      return Promise.resolve({
        content: TEMPLATE_CONTENT,
        sha: "t1",
        size: TEMPLATE_CONTENT.length,
      });
    }
    return Promise.reject(new Error(`Not found: fetchFile slug/${path}`));
  };
}

async function setupBootstrap(handoffContent: string): Promise<CapturedHandler> {
  vi.resetModules();
  vi.clearAllMocks();

  const ghClient = await import("../src/github/client.js");
  const mockFetchFile = vi.mocked(ghClient.fetchFile);
  const mockPushFile = vi.mocked(ghClient.pushFile);
  const mockFetchFiles = vi.mocked(ghClient.fetchFiles);
  const mockFileExists = vi.mocked(ghClient.fileExists);
  const mockListRepos = vi.mocked(ghClient.listRepos);

  mockFetchFile.mockImplementation(makeFetchFileMock(handoffContent));
  mockPushFile.mockResolvedValue({ success: true, sha: "pushed", size: 100 });
  mockFetchFiles.mockResolvedValue({
    files: new Map(),
    failed: [],
    incomplete: false,
  });
  mockFileExists.mockResolvedValue(false);
  mockListRepos.mockResolvedValue([]);

  let captured: CapturedHandler | null = null;
  const mockServer = {
    tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => {
      if (name === "prism_bootstrap") captured = handler as CapturedHandler;
    }),
  } as unknown as McpServer;

  const { registerBootstrap } = await import("../src/tools/bootstrap.js");
  registerBootstrap(mockServer);
  if (!captured) throw new Error("prism_bootstrap handler was not registered");
  return captured;
}

beforeEach(() => {
  process.env.TRIGGER_AUTO_ENROLL = "false";
});

describe("brief-411: bootstrap reads persisted recommendation", () => {
  it("surfaces the persisted block exactly when present in handoff.md", async () => {
    const handoff = buildHandoff({
      withPersistedBlock: true,
      // Even though next_steps point at design work, the persisted block
      // says executional — that's the point of the brief: the persisted
      // verdict wins, no reclassification at boot.
      nextSteps: [
        "Design the new orchestrator",
        "Architect the cleanup pipeline",
        "Investigate prior art",
      ],
      criticalContext: [
        "Past-tense executional language: deployed, executed, reconnect.",
      ],
    });

    const handler = await setupBootstrap(handoff);
    const result = await handler({ project_slug: "test-project" });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.recommended_session_settings).toBeTruthy();
    expect(parsed.recommended_session_settings.category).toBe("executional");
    expect(parsed.recommended_session_settings.model).toBe("sonnet-4-6");
    expect(parsed.recommended_session_settings.thinking).toBe("adaptive-off");
    expect(parsed.recommended_session_settings.display).toBe("Sonnet 4.6 · Adaptive off");
    expect(parsed.recommended_session_settings.rationale).toBe(
      "Queue is mechanical cleanup / patches",
    );
  });

  it("falls back to next_steps-only classification when block is absent (back-compat)", async () => {
    // Pre-411 handoff — no persisted block. next_steps are clearly design /
    // investigation work. The fallback must yield reasoning_heavy.
    const handoff = buildHandoff({
      withPersistedBlock: false,
      nextSteps: [
        "Design the new orchestration architecture",
        "Brainstorm tradeoffs and compare strategy options",
        "Investigate the failure mode and propose a fix",
      ],
      criticalContext: ["Some context."],
    });

    const handler = await setupBootstrap(handoff);
    const result = await handler({ project_slug: "test-project" });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.recommended_session_settings.category).toBe("reasoning_heavy");
    expect(parsed.recommended_session_settings.model).toBe("opus-4-7");
    expect(parsed.recommended_session_settings.thinking).toBe("adaptive-on");
  });

  it("fallback ignores critical_context — the S107 bug is fixed", async () => {
    // The S107→S108 bug: bootstrap classified with critical_context which
    // contained past-tense executional language (deployed, executed,
    // reconnect) and produced a different verdict than finalize. After
    // brief-411, the fallback path must not consume critical_context.
    //
    // next_steps is empty/minimal — a heavy executional critical_context
    // would have flipped the verdict pre-411. The new fallback must NOT
    // flip it.
    const handoff = buildHandoff({
      withPersistedBlock: false,
      nextSteps: [
        "Design the new architecture",
        "Architect the integration",
        "Investigate prior art",
      ],
      criticalContext: [
        "Cleanup, patch, push, verify, bump, sync, and apply the changelog backfill.",
        "Update the deploy pipeline and consolidate logs.",
      ],
    });

    const handler = await setupBootstrap(handoff);
    const result = await handler({ project_slug: "test-project" });
    const parsed = JSON.parse(result.content[0].text);

    // Verdict comes from next_steps alone — reasoning_heavy.
    expect(parsed.recommended_session_settings.category).toBe("reasoning_heavy");
  });

  it("fallback ignores opening_message — the S107 bug is fixed", async () => {
    // Same fix vs the opening_message side: pre-411, an executional opening
    // message could flip a reasoning-heavy queue. After brief-411, the
    // fallback path must not consume opening_message either.
    const handoff = buildHandoff({
      withPersistedBlock: false,
      nextSteps: [
        "Design the orchestrator",
        "Architect the cleanup pipeline",
        "Brainstorm strategy options",
      ],
      criticalContext: ["Some context."],
    });

    const handler = await setupBootstrap(handoff);
    const result = await handler({
      project_slug: "test-project",
      opening_message:
        "Just need to cleanup, patch, push, verify, and bump the changelog",
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.recommended_session_settings.category).toBe("reasoning_heavy");
  });
});
