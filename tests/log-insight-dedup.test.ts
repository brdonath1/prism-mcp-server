// A-4: server-side dedup for prism_log_insight
//
// Unit tests for parseExistingInsightIds() and the dedup rejection flow.
// Mirrors the log-decision-dedup.test.ts pattern.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  pushFile: vi.fn(),
  fileExists: vi.fn(),
  listDirectory: vi.fn(),
}));

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocPath: vi.fn(),
  resolveDocPushPath: vi.fn(),
}));

vi.mock("../src/utils/doc-guard.js", () => ({
  guardPushPath: vi.fn(),
}));

import { pushFile } from "../src/github/client.js";
import { resolveDocPath, resolveDocPushPath } from "../src/utils/doc-resolver.js";
import { guardPushPath } from "../src/utils/doc-guard.js";

const mockPushFile = vi.mocked(pushFile);
const mockResolveDocPath = vi.mocked(resolveDocPath);
const mockResolveDocPushPath = vi.mocked(resolveDocPushPath);
const mockGuardPushPath = vi.mocked(guardPushPath);

import {
  parseExistingInsightIds,
  registerLogInsight,
} from "../src/tools/log-insight.js";

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

const INSIGHTS_WITH_9999 = `# Insights — test-project

> Institutional knowledge. Entries tagged **STANDING RULE** are auto-loaded at bootstrap (D-44 Track 1).

## Active

### INS-9998: Earlier insight
- Category: pattern
- Discovered: Session 42
- Description: Something useful.

### INS-9999: Existing insight
- Category: gotcha
- Discovered: Session 43
- Description: Already logged.

### INS-10001: Standing rule example — STANDING RULE
- Category: preference — **STANDING RULE**
- Discovered: Session 44
- Description: A standing rule.
- **Standing procedure:** Always do X, then Y.

## Formalized

<!-- EOF: insights.md -->
`;

const EMPTY_INSIGHTS = `# Insights — test-project

## Active

## Formalized

<!-- EOF: insights.md -->
`;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseExistingInsightIds", () => {
  it("returns INS-N IDs with titles from an existing insights.md", () => {
    const ids = parseExistingInsightIds(INSIGHTS_WITH_9999);
    // 3 INS-N entries in the fixture: 9998, 9999, 10001.
    expect(ids.size).toBe(3);
    expect(ids.get("INS-9998")).toBe("Earlier insight");
    expect(ids.get("INS-9999")).toBe("Existing insight");
    // Standing-rule suffix must be stripped from the title.
    expect(ids.get("INS-10001")).toBe("Standing rule example");
  });

  it("returns empty for a fresh file with no entries", () => {
    const ids = parseExistingInsightIds(EMPTY_INSIGHTS);
    expect(ids.size).toBe(0);
  });

  it("ignores ## headers that are not INS-N entries", () => {
    const content = "# Insights\n\n## Active\n\n## Formalized\n\n";
    const ids = parseExistingInsightIds(content);
    expect(ids.size).toBe(0);
  });
});

describe("prism_log_insight dedup guard (A-4)", () => {
  it("rejects the write when INS-N already exists", async () => {
    mockResolveDocPath.mockResolvedValueOnce({
      path: ".prism/insights.md",
      content: INSIGHTS_WITH_9999,
      sha: "ins-sha",
      legacy: false,
    });

    const { server, handlers } = createServerStub();
    registerLogInsight(server as any);
    const handler = handlers.prism_log_insight;
    expect(handler).toBeDefined();

    const result = await handler({
      project_slug: "test-project",
      id: "INS-9999",
      title: "Attempted duplicate",
      category: "gotcha",
      description: "Should be rejected before any push.",
      session: 50,
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.duplicate).toBe(true);
    expect(payload.id).toBe("INS-9999");
    expect(payload.existing_title).toBe("Existing insight");
    expect(payload.error).toContain("INS-9999 already exists");
    // Guard must fire BEFORE any GitHub write.
    expect(mockPushFile).not.toHaveBeenCalled();
  });

  it("accepts a fresh ID that doesn't clash", async () => {
    mockResolveDocPath.mockResolvedValueOnce({
      path: ".prism/insights.md",
      content: INSIGHTS_WITH_9999,
      sha: "ins-sha",
      legacy: false,
    });
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new" });

    const { server, handlers } = createServerStub();
    registerLogInsight(server as any);

    const handler = handlers.prism_log_insight;
    const result = await handler({
      project_slug: "test-project",
      id: "INS-10000",
      title: "Brand new insight",
      category: "pattern",
      description: "Unique ID should be accepted.",
      session: 50,
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.id).toBe("INS-10000");
    expect(payload.success).toBe(true);
    expect(mockPushFile).toHaveBeenCalledTimes(1);
  });

  it("skips dedup when insights.md does not exist yet (fresh file)", async () => {
    // resolveDocPath throws → file does not exist → fresh file path.
    mockResolveDocPath.mockRejectedValueOnce(new Error("Not found"));
    mockResolveDocPushPath.mockResolvedValue(".prism/insights.md");
    mockGuardPushPath.mockResolvedValue({
      path: ".prism/insights.md",
      redirected: false,
    });
    mockPushFile.mockResolvedValue({ success: true, size: 100, sha: "new" });

    const { server, handlers } = createServerStub();
    registerLogInsight(server as any);

    const handler = handlers.prism_log_insight;
    const result = await handler({
      project_slug: "test-project",
      id: "INS-1",
      title: "First-ever insight",
      category: "pattern",
      description: "Fresh file has no dedup set to check against.",
      session: 1,
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.id).toBe("INS-1");
    expect(mockPushFile).toHaveBeenCalledTimes(1);
  });
});
