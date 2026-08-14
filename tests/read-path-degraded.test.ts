/**
 * R30 / S203 F-C1-14 — a read-path failure must produce a DEGRADED signal, not
 * a confident zero.
 *
 * Before this change, `prism_status` and `prism_analytics` swallowed EVERY
 * document-read error into the same empty-string default, so a transient 401 /
 * network reset / rate limit was reported as `handoff_version: 0,
 * session_count: 0` — a measured-looking number derived from no evidence, with
 * nothing in the response to say the read never happened. For a continuity
 * framework that is the worst failure mode there is: the chat operator reads
 * "0 sessions" as fact.
 *
 * The contract now: only a genuine 404 ("Not found") means ABSENT and keeps the
 * zero defaults. Every other error nulls the affected fields and raises a
 * DOC_READ_DEGRADED diagnostic.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
  fetchFiles: vi.fn(),
  fileExists: vi.fn(),
  listDirectory: vi.fn(),
  listRepos: vi.fn(),
  listCommits: vi.fn(),
  getCommit: vi.fn(),
}));

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocPath: vi.fn(),
  resolveDocExists: vi.fn(),
  resolveDocFiles: vi.fn(),
}));

import { listDirectory, listRepos } from "../src/github/client.js";
import { resolveDocPath, resolveDocExists } from "../src/utils/doc-resolver.js";
import {
  registerStatus,
  clearHandoffExistenceCache,
  clearRepoListCache,
} from "../src/tools/status.js";
import { registerAnalytics } from "../src/tools/analytics.js";

const mockListDirectory = vi.mocked(listDirectory);
const mockListRepos = vi.mocked(listRepos);
const mockResolveDocPath = vi.mocked(resolveDocPath);
const mockResolveDocExists = vi.mocked(resolveDocExists);

/** The INS-311 shape: a GitHub auth blip, NOT a 404. */
const AUTH_BLIP = new Error("GitHub API error (401): Bad credentials");
/** The only error that legitimately means "the document is not there". */
const NOT_FOUND = new Error("Not found: .prism/handoff.md");

const LIVING_DOC_NAMES = [
  "handoff.md", "session-log.md", "task-queue.md", "eliminated.md",
  "architecture.md", "glossary.md", "known-issues.md", "insights.md",
  "intelligence-brief.md",
];

function createServerStub() {
  const handlers: Record<string, Function> = {};
  const server = {
    tool(name: string, _description: string, _schema: unknown, handler: Function) {
      handlers[name] = handler;
    },
  };
  return { server, handlers };
}

async function callStatus(args: Record<string, unknown>): Promise<any> {
  const { server, handlers } = createServerStub();
  registerStatus(server as any);
  const result = await handlers.prism_status(args, {});
  return JSON.parse(result.content[0].text);
}

async function callAnalytics(args: Record<string, unknown>): Promise<any> {
  const { server, handlers } = createServerStub();
  registerAnalytics(server as any);
  const result = await handlers.prism_analytics(args, {});
  return JSON.parse(result.content[0].text);
}

/** A `.prism/` listing where every living doc exists — the read that succeeds. */
function listingWithAllDocs() {
  mockListDirectory.mockImplementation(async (_repo: string, path: string) => {
    if (path === ".prism") {
      return LIVING_DOC_NAMES.map((name) => ({
        name, path: `.prism/${name}`, size: 400, sha: "s", type: "file" as const,
      }));
    }
    if (path === ".prism/decisions") {
      return [{ name: "_INDEX.md", path: ".prism/decisions/_INDEX.md", size: 400, sha: "s", type: "file" as const }];
    }
    return [];
  });
}

function diagnosticCodes(payload: any): string[] {
  return (payload.diagnostics ?? []).map((d: any) => d.code);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearRepoListCache();
  clearHandoffExistenceCache();
});

describe("R30 — prism_status", () => {
  it("resolveDocPath rejects with a 401-shaped error → affected fields null + DOC_READ_DEGRADED present", async () => {
    listingWithAllDocs();
    mockResolveDocPath.mockRejectedValue(AUTH_BLIP);

    const payload = await callStatus({ project_slug: "prism", include_details: false });

    // The unverified fields are null — NOT 0, NOT "unknown".
    expect(payload.handoff_version).toBeNull();
    expect(payload.session_count).toBeNull();
    expect(payload.current_status).toBeNull();
    expect(payload.handoff_read_degraded).toBe(true);

    const degraded = payload.diagnostics.find((d: any) => d.code === "DOC_READ_DEGRADED");
    expect(degraded).toBeDefined();
    expect(degraded.level).toBe("warn");
    expect(degraded.context).toMatchObject({ project: "prism", document: "handoff.md" });
  });

  it("listing-derived fields stay MEASURED when only the content read degrades", async () => {
    listingWithAllDocs();
    mockResolveDocPath.mockRejectedValue(AUTH_BLIP);

    const payload = await callStatus({ project_slug: "prism", include_details: false });

    // The directory listing succeeded, so presence/size/health remain facts.
    expect(payload.handoff_size_bytes).toBe(400);
    expect(payload.documents_present).toBe(payload.documents_total);
    expect(payload.health).toBe("healthy");
  });

  it("a genuine 404 is still ABSENT — zero defaults, no degraded diagnostic", async () => {
    listingWithAllDocs();
    mockResolveDocPath.mockRejectedValue(NOT_FOUND);

    const payload = await callStatus({ project_slug: "prism", include_details: false });

    expect(payload.handoff_version).toBe(0);
    expect(payload.session_count).toBe(0);
    expect(payload.current_status).toBe("unknown");
    expect(payload.handoff_read_degraded).toBeUndefined();
    expect(diagnosticCodes(payload)).not.toContain("DOC_READ_DEGRADED");
  });

  it("a successful read is unchanged — real numbers, no diagnostic", async () => {
    listingWithAllDocs();
    mockResolveDocPath.mockResolvedValue({
      path: ".prism/handoff.md",
      content: [
        "## Meta",
        "- Handoff Version: 12",
        "- Session Count: 40",
        "- Status: Active",
        "",
        "<!-- EOF: handoff.md -->",
      ].join("\n"),
      sha: "h",
      legacy: false,
    } as any);

    const payload = await callStatus({ project_slug: "prism", include_details: false });

    expect(payload.handoff_version).toBe(12);
    expect(payload.session_count).toBe(40);
    expect(payload.current_status).toBe("Active");
    expect(diagnosticCodes(payload)).not.toContain("DOC_READ_DEGRADED");
  });

  it("the multi-project sweep names the degraded project in the diagnostic", async () => {
    listingWithAllDocs();
    mockListRepos.mockResolvedValue(["alpha"]);
    mockResolveDocExists.mockResolvedValue({ exists: true, path: ".prism/handoff.md", legacy: false });
    mockResolveDocPath.mockRejectedValue(AUTH_BLIP);

    const payload = await callStatus({ include_details: false });

    const degraded = payload.diagnostics.find((d: any) => d.code === "DOC_READ_DEGRADED");
    expect(degraded).toBeDefined();
    expect(degraded.context.project).toBe("alpha");
    expect(payload.projects[0].session_count).toBeNull();
  });
});

describe("R30 — prism_analytics handoff_size_history", () => {
  beforeEach(() => {
    // No handoff-history/ directory — the metric's other input.
    mockListDirectory.mockResolvedValue([]);
  });

  it("resolveDocPath rejects with a 401-shaped error → affected fields null + DOC_READ_DEGRADED present", async () => {
    mockResolveDocPath.mockRejectedValue(AUTH_BLIP);

    const payload = await callAnalytics({ project_slug: "prism", metric: "handoff_size_history" });

    expect(payload.data.current_size_bytes).toBeNull();
    expect(payload.data.current_size_kb).toBeNull();
    expect(payload.data.current_version).toBeNull();
    expect(payload.data.current_read_degraded).toBe(true);
    // The summary must not claim a measured "0.0KB (v0)".
    expect(payload.summary).not.toMatch(/0\.0KB/);
    expect(payload.summary).toMatch(/UNREAD/);

    const degraded = payload.diagnostics.find((d: any) => d.code === "DOC_READ_DEGRADED");
    expect(degraded).toBeDefined();
    expect(degraded.context).toMatchObject({ project: "prism", document: "handoff.md" });
  });

  it("a genuine 404 keeps the documented zero defaults with no diagnostic", async () => {
    mockResolveDocPath.mockRejectedValue(NOT_FOUND);

    const payload = await callAnalytics({ project_slug: "prism", metric: "handoff_size_history" });

    expect(payload.data.current_size_bytes).toBe(0);
    expect(payload.data.current_version).toBe(0);
    expect(payload.data.current_read_degraded).toBe(false);
    expect(diagnosticCodes(payload)).not.toContain("DOC_READ_DEGRADED");
  });
});

describe("R30 — prism_analytics fresh_eyes_check", () => {
  it("a degraded handoff read reports null counts and no overdue verdict", async () => {
    mockResolveDocPath.mockRejectedValue(AUTH_BLIP);

    const payload = await callAnalytics({ project_slug: "prism", metric: "fresh_eyes_check" });

    const detail = payload.data.details[0];
    expect(detail.session_count).toBeNull();
    expect(detail.sessions_since_fresh_eyes).toBeNull();
    expect(detail.overdue).toBe(false);
    expect(detail.read_degraded).toBe(true);
    expect(diagnosticCodes(payload)).toContain("DOC_READ_DEGRADED");
  });

  it("a degraded SESSION-LOG read does not manufacture an overdue verdict", async () => {
    mockResolveDocPath.mockImplementation(async (_slug: string, docName: string) => {
      if (docName === "handoff.md") {
        return {
          path: ".prism/handoff.md",
          content: "## Meta\n- Session Count: 99\n\n<!-- EOF: handoff.md -->",
          sha: "h",
          legacy: false,
        } as any;
      }
      throw AUTH_BLIP;
    });

    const payload = await callAnalytics({ project_slug: "prism", metric: "fresh_eyes_check" });

    const detail = payload.data.details[0];
    // 99 sessions with an unreadable log would otherwise read as "89 sessions
    // overdue" — an alarm invented from an auth blip.
    expect(detail.session_count).toBe(99);
    expect(detail.sessions_since_fresh_eyes).toBeNull();
    expect(detail.overdue).toBe(false);
    expect(payload.data.overdue_count).toBe(0);

    const degraded = payload.diagnostics.find((d: any) => d.code === "DOC_READ_DEGRADED");
    expect(degraded.context).toMatchObject({ document: "session-log.md" });
  });

  it("an absent handoff (404) keeps the pre-existing zero shape", async () => {
    mockResolveDocPath.mockRejectedValue(NOT_FOUND);

    const payload = await callAnalytics({ project_slug: "prism", metric: "fresh_eyes_check" });

    const detail = payload.data.details[0];
    expect(detail.session_count).toBe(0);
    expect(detail.sessions_since_fresh_eyes).toBe(0);
    expect(detail.overdue).toBe(false);
    expect(diagnosticCodes(payload)).not.toContain("DOC_READ_DEGRADED");
  });
});
