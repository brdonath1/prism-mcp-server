/**
 * brief-459 (W3-S3, M-006) — SRV-23: fresh_eyes_check scanned the session-log
 * bottom-up for the "last" fresh-eyes mention, which on newest-FIRST logs
 * finds the OLDEST review ever and cries overdue forever; the 10-line session
 * lookback was fragile besides. The fix collects ALL mentions, resolves each
 * to its containing session via the nearest preceding session header, and
 * takes the maximum session number — orientation-independent.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocPath: vi.fn(),
  resolveDocExists: vi.fn(),
  resolveDocFiles: vi.fn(),
}));
vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  listDirectory: vi.fn(),
  listCommits: vi.fn(),
  listRepos: vi.fn(),
  getCommit: vi.fn(),
}));

import { resolveDocPath } from "../src/utils/doc-resolver.js";
import {
  registerAnalytics,
  resolveLastFreshEyesSession,
} from "../src/tools/analytics.js";

const mockResolveDocPath = vi.mocked(resolveDocPath);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("brief-459 / SRV-23: resolveLastFreshEyesSession", () => {
  it("newest-first log: a fresh-eyes review in the LATEST session wins over an ancient one", () => {
    const log = [
      "# Session Log",
      "",
      "### Session 20 (2026-06-01)",
      "Ran the fresh-eyes review — all clear.",
      "",
      "### Session 12 (2026-04-01)",
      "Routine work.",
      "",
      "### Session 5 (2026-02-01)",
      "First fresh-eyes review of the project.",
      "",
      "<!-- EOF: session-log.md -->",
    ].join("\n").toLowerCase();
    expect(resolveLastFreshEyesSession(log)).toBe(20);
  });

  it("chronological log: same outcome (orientation-independent)", () => {
    const log = [
      "### Session 5 (2026-02-01)",
      "First fresh-eyes review of the project.",
      "",
      "### Session 12 (2026-04-01)",
      "Routine work.",
      "",
      "### Session 20 (2026-06-01)",
      "Ran the fresh-eyes review — all clear.",
    ].join("\n").toLowerCase();
    expect(resolveLastFreshEyesSession(log)).toBe(20);
  });

  it("attribution uses the CONTAINING session header, not a 10-line window", () => {
    // The mention sits 15 lines below its session header — the old lookback
    // missed it entirely.
    const farBody = Array.from({ length: 15 }, (_, i) => `- item ${i + 1}`);
    const log = [
      "### Session 18 (2026-05-20)",
      ...farBody,
      "Completed fresh eyes pass on architecture docs.",
      "",
      "### Session 17 (2026-05-10)",
      "Routine.",
    ].join("\n").toLowerCase();
    expect(resolveLastFreshEyesSession(log)).toBe(18);
  });

  it('matches the "fresh eyes" spelling variant', () => {
    const log = "### Session 9 (2026-03-01)\ndid a fresh eyes review today.".toLowerCase();
    expect(resolveLastFreshEyesSession(log)).toBe(9);
  });

  it("PF2-style headers (## sN — date) attribute correctly", () => {
    const log = [
      "## s162 — 03-15-26",
      "fresh-eyes sweep finished.",
      "",
      "## s150 — 02-01-26",
      "routine.",
    ].join("\n");
    expect(resolveLastFreshEyesSession(log)).toBe(162);
  });

  it("a mention before ANY session header is ignored", () => {
    const log = [
      "# Session Log",
      "> reminder: schedule a fresh-eyes review",
      "",
      "### Session 3 (2026-01-10)",
      "Routine work, no review.",
    ].join("\n").toLowerCase();
    expect(resolveLastFreshEyesSession(log)).toBe(0);
  });

  it("returns 0 when there are no fresh-eyes mentions at all", () => {
    const log = "### Session 4 (2026-01-20)\nRoutine.".toLowerCase();
    expect(resolveLastFreshEyesSession(log)).toBe(0);
  });
});

// The audit's missing_test line verbatim: "freshEyesCheck against a
// newest-first session-log where fresh-eyes occurred in the latest session,
// asserting overdue=false."
describe("brief-459 / SRV-23: fresh_eyes_check end-to-end", () => {
  function createServerStub() {
    const handlers: Record<string, Function> = {};
    const server = {
      tool(name: string, _description: string, _schema: unknown, handler: Function) {
        handlers[name] = handler;
      },
    };
    return { server, handlers };
  }

  const HANDOFF = [
    "## Meta",
    "- Handoff Version: 24",
    "- Session Count: 25",
    "- Template Version: 2.0.0",
    "- Status: active",
    "",
    "<!-- EOF: handoff.md -->",
  ].join("\n");

  // Newest-FIRST: the latest session (24, with the fresh-eyes review) is at
  // the TOP; an ancient review (session 5) sits at the BOTTOM, where the old
  // bottom-up scan found it and inflated sessions_since_fresh_eyes to 20.
  const NEWEST_FIRST_LOG = [
    "# Session Log",
    "",
    "### Session 24 (2026-06-10)",
    "Ran the fresh-eyes review — all clear.",
    "",
    "### Session 12 (2026-04-01)",
    "Routine work.",
    "",
    "### Session 5 (2026-02-01)",
    "First fresh-eyes review of the project.",
    "",
    "<!-- EOF: session-log.md -->",
  ].join("\n");

  it("newest-first log with a latest-session review reports overdue=false", async () => {
    mockResolveDocPath.mockImplementation(async (_slug: string, docName: string) => {
      if (docName === "handoff.md") {
        return { path: ".prism/handoff.md", content: HANDOFF, sha: "h", legacy: false };
      }
      if (docName === "session-log.md") {
        return { path: ".prism/session-log.md", content: NEWEST_FIRST_LOG, sha: "s", legacy: false };
      }
      throw new Error(`Not found: ${docName}`);
    });

    const { server, handlers } = createServerStub();
    registerAnalytics(server as any);
    const result = await handlers.prism_analytics({
      project_slug: "test-project",
      metric: "fresh_eyes_check",
    });
    const payload = JSON.parse(result.content[0].text);

    const detail = payload.data.details.find((d: any) => d.project === "test-project");
    expect(detail).toBeDefined();
    expect(detail.last_fresh_eyes_session).toBe(24);
    expect(detail.sessions_since_fresh_eyes).toBe(1);
    expect(detail.overdue).toBe(false);
    expect(payload.data.overdue_count).toBe(0);
  });
});
