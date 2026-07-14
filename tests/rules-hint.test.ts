// brief-s202b T2 — rules_hint stateless module nudges.
// Ingest-path writes (prism_push / prism_patch) carry a ≤120B pointer to the
// document-ingest module; every cc_dispatch response carries the CC-channel
// discipline pointer. Emitted on every matching call (server is stateless).
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
}));

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CC_DISPATCH_RULES_HINT,
  INGEST_RULES_HINT,
  RULES_HINT_MAX_BYTES,
  ingestRulesHint,
} from "../src/utils/rules-hint.js";
import { registerPush } from "../src/tools/push.js";

describe("brief-s202b T2 — rules_hint helper", () => {
  it("every hint constant honors the 120-byte budget", () => {
    const encoder = new TextEncoder();
    expect(encoder.encode(INGEST_RULES_HINT).length).toBeLessThanOrEqual(RULES_HINT_MAX_BYTES);
    expect(encoder.encode(CC_DISPATCH_RULES_HINT).length).toBeLessThanOrEqual(RULES_HINT_MAX_BYTES);
  });

  it("matches `.prism/ingest/` prefixed paths only", () => {
    expect(ingestRulesHint([".prism/ingest/upload.md"])).toBe(INGEST_RULES_HINT);
    expect(ingestRulesHint(["docs/a.md", ".prism/ingest/deliverable.md"])).toBe(INGEST_RULES_HINT);
    expect(ingestRulesHint([".prism/handoff.md"])).toBeUndefined();
    expect(ingestRulesHint(["ingest/upload.md"])).toBeUndefined();
    expect(ingestRulesHint([])).toBeUndefined();
  });
});

describe("brief-s202b T2 — prism_push carries rules_hint on ingest writes", () => {
  let pushHandler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
  const mockServer = {
    tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => {
      if (name === "prism_push") pushHandler = handler as typeof pushHandler;
    }),
  } as unknown as McpServer;

  beforeEach(() => {
    vi.clearAllMocks();
    registerPush(mockServer);
  });

  it("a validation-failed ingest push still carries the hint (a failing ingest write needs the module MORE)", async () => {
    // Invalid commit prefix → validation fails before any GitHub call.
    const result = await pushHandler({
      project_slug: "prism",
      files: [
        {
          path: ".prism/ingest/upload-notes.md",
          content: "# Notes\n\n<!-- EOF: upload-notes.md -->\n",
          message: "bad-prefix: nope",
        },
      ],
      skip_validation: false,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.all_succeeded).toBe(false);
    expect(parsed.rules_hint).toBe(INGEST_RULES_HINT);
  });

  it("a non-ingest push carries NO rules_hint field (additive — absent, not null)", async () => {
    const result = await pushHandler({
      project_slug: "prism",
      files: [
        {
          path: "docs/notes.md",
          content: "# Notes\n\n<!-- EOF: notes.md -->\n",
          message: "bad-prefix: nope",
        },
      ],
      skip_validation: false,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect("rules_hint" in parsed).toBe(false);
  });
});
