/**
 * INS-360 (brief-s201c) — finalize-audit `needs_creation` false-negative FIX tests.
 *
 * brief-s195b pinned the defective behavior with characterization tests
 * (INS-177 audit-then-fix); this file is their mandated inversion. Root cause
 * (docs/rca/ins-360-finalize-audit-false-negative.md): resolveDocFiles'
 * fulfilled-only Promise.allSettled loop silently swallowed every operational
 * fetch failure, so auditPhase classified an EXISTING living doc as
 * `exists: false, needs_creation: true` and the downstream commit overwrote
 * real history (the S191/S192 session-log.md incident).
 *
 * The fixed invariant (brief-s201c):
 *   - `needs_creation` ONLY on CONFIRMED absence: definitive GitHub 404 AND a
 *     path-filtered commit-history probe (`GET /commits?path=<doc>&per_page=1`)
 *     returning zero commits for the path at both layouts.
 *   - Any other failure shape (5xx, timeout, auth blip, rate limit) OR a 404
 *     where the path HAS commit history → `unverified` (new status) + a
 *     FINALIZE_AUDIT_UNVERIFIED_DOC diagnostic — neither healthy nor missing.
 *   - Recreate guard: draft and commit/full never generate or push a
 *     from-scratch replacement for an `unverified` doc; creation stays allowed
 *     only for confirmed `needs_creation`.
 *
 * Mock style: globalThis.fetch with URL + method assertions (INS-31 pattern,
 * mirroring tests/github-transient-errors.test.ts) so the REAL
 * fetchWithRetry → fetchFile → resolveDocPath → auditPhase chain runs.
 */

// Set dummy PAT to prevent config.ts from calling process.exit(1) during import.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFinalize } from "../src/tools/finalize.js";
import { LIVING_DOCUMENT_NAMES } from "../src/config.js";

/** Build a 200 JSON contents response with base64 content. */
function contentsOk(content: string, sha = "sha-1"): Response {
  return new Response(
    JSON.stringify({
      content: Buffer.from(content, "utf-8").toString("base64"),
      sha,
      size: content.length,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function notFound(): Response {
  return new Response(JSON.stringify({ message: "Not Found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

/** GitHub list-commits item shape (what listCommits parses). */
function commitItem(sha: string): Record<string, unknown> {
  return {
    sha,
    commit: { message: `prism: earlier commit ${sha}`, author: { date: "2026-07-01T00:00:00Z" } },
  };
}

const HANDOFF_CONTENT = `## Meta
- Handoff Version: 30
- Session Count: 190
- Template Version: v2.9.0
- Status: Active

## Critical Context
1. PRISM MCP Server is the core infrastructure

## Where We Are
Finalizing session 191.

<!-- EOF: handoff.md -->`;

/** Minimal valid content for every living document, keyed by bare doc name. */
const LIVING_DOCS_CONTENT: Record<string, string> = {
  "handoff.md": HANDOFF_CONTENT,
  "decisions/_INDEX.md": `| ID | Title | Domain | Status | Session |
|---|---|---|---|---|
| D-1 | Example | architecture | SETTLED | S1 |
<!-- EOF: _INDEX.md -->`,
  "session-log.md": "# Session Log\n\n### Session 189 (2026-07-10)\nLive entries S185-S189.\n\n<!-- EOF: session-log.md -->",
  "task-queue.md": "# Task Queue\n<!-- EOF: task-queue.md -->",
  "eliminated.md": "# Eliminated\n<!-- EOF: eliminated.md -->",
  "architecture.md": "# Architecture\n<!-- EOF: architecture.md -->",
  "glossary.md": "# Glossary\n<!-- EOF: glossary.md -->",
  "known-issues.md": "# Known Issues\n<!-- EOF: known-issues.md -->",
  "insights.md": "# Insights\n<!-- EOF: insights.md -->",
  "intelligence-brief.md": "# Intelligence Brief\n<!-- EOF: intelligence-brief.md -->",
};

interface RecordedRequest {
  url: string;
  method: string;
}

/**
 * Route every GitHub API URL the finalize paths touch. The doc at `failPath`
 * (a `.prism/`-prefixed contents path) answers with `failWith(callNumber)`;
 * all other living docs resolve; handoff-history, legacy-root fallbacks, and
 * the framework rules template 404. `/commits?path=…` answers from
 * `pathCommits` (keyed by DECODED path, default zero history); `/commits?`
 * without a path filter (session work products) returns [].
 */
function makeFetchRouter(opts: {
  failPath?: string;
  failWith?: (call: number) => Response;
  pathCommits?: Record<string, Array<Record<string, unknown>>>;
}): { fetchImpl: typeof fetch; recorded: RecordedRequest[] } {
  const recorded: RecordedRequest[] = [];
  let failCalls = 0;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    recorded.push({ url: u, method: (init?.method ?? "GET").toUpperCase() });
    if (u.includes("/commits?")) {
      const pathParam = new URL(u).searchParams.get("path");
      if (pathParam !== null) {
        const history = opts.pathCommits?.[pathParam] ?? [];
        return new Response(JSON.stringify(history), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (opts.failPath && u.includes(`/contents/${opts.failPath}`)) {
      failCalls += 1;
      return opts.failWith!(failCalls);
    }
    const docMatch = u.match(/\/contents\/\.prism\/(.+?)(?:\?|$)/);
    if (docMatch) {
      const docName = decodeURIComponent(docMatch[1]);
      const body = LIVING_DOCS_CONTENT[docName];
      if (body !== undefined) return contentsOk(body, `sha-${docName}`);
    }
    // handoff-history listings, legacy-root fallbacks, rules-session-end.md
    return notFound();
  }) as typeof fetch;
  return { fetchImpl, recorded };
}

/** Requests issued for a given contents path (exact-path match, either repo). */
function requestsFor(recorded: RecordedRequest[], contentsPath: string): RecordedRequest[] {
  return recorded.filter((r) => r.url.endsWith(`/contents/${contentsPath}`));
}

/** Commit-history probes issued for a given (decoded) path filter. */
function historyProbesFor(recorded: RecordedRequest[], path: string): RecordedRequest[] {
  return recorded.filter((r) => {
    if (!r.url.includes("/commits?")) return false;
    return new URL(r.url).searchParams.get("path") === path;
  });
}

/** Invoke prism_finalize via the McpServer internal handler (integration-test pattern). */
async function callFinalize(args: Record<string, unknown>): Promise<any> {
  const server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerFinalize(server);
  const tool = (server as any)._registeredTools["prism_finalize"];
  if (!tool) throw new Error("Tool not registered");
  const result = await tool.handler(
    { project_slug: "test-project", session_number: 191, ...args },
    {
      signal: new AbortController().signal,
      _meta: undefined,
      requestId: "test-ins-360",
      sendNotification: vi.fn().mockResolvedValue(undefined),
      sendRequest: vi.fn().mockResolvedValue(undefined),
    },
  );
  return JSON.parse(result.content[0].text);
}

async function callFinalizeAudit(): Promise<any> {
  return callFinalize({ action: "audit" });
}

const SESSION_LOG_PRISM_PATH = ".prism/session-log.md";
const SESSION_LOG_URL =
  "https://api.github.com/repos/test-owner/test-project/contents/.prism/session-log.md";

function findSessionLog(data: any): any {
  return data.audit.living_documents.find((d: any) => d.file === "session-log.md");
}

function unverifiedDiagnosticsFor(data: any, doc: string): Array<{ code: string; message: string }> {
  return (data.diagnostics ?? []).filter(
    (d: any) => d.code === "FINALIZE_AUDIT_UNVERIFIED_DOC" && (d.message ?? "").includes(doc),
  );
}

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ── Healthy path stays byte-compatible ─────────────────────────────────────────

describe("INS-360 fix — healthy-path audit output is unchanged", () => {
  it("all docs resolve → every entry keeps exactly the pre-INS-360 field set (no status/fetch_error keys)", async () => {
    const { fetchImpl } = makeFetchRouter({});
    globalThis.fetch = fetchImpl;

    const data = await callFinalizeAudit();

    expect(data.audit.living_documents).toHaveLength(LIVING_DOCUMENT_NAMES.length);
    for (const entry of data.audit.living_documents) {
      expect(entry.exists).toBe(true);
      expect(entry.needs_creation).toBe(false);
      // Byte-compatibility pin: healthy entries carry EXACTLY the historical keys.
      expect(Object.keys(entry).sort()).toEqual(
        ["eof_valid", "exists", "file", "header_line", "needs_creation", "section_headers", "size_bytes"],
      );
    }
    expect((data.diagnostics ?? []).filter((d: any) => d.code === "FINALIZE_AUDIT_UNVERIFIED_DOC")).toHaveLength(0);
  }, 10_000);
});

// ── Invariant: needs_creation requires CONFIRMED absence ───────────────────────

describe("INS-360 fix — needs_creation only on confirmed absence (404 + zero path commit history)", () => {
  it("definitive 404 on both layouts + zero commits for the path → needs_creation (history probe URL + method asserted)", async () => {
    const { fetchImpl, recorded } = makeFetchRouter({
      failPath: SESSION_LOG_PRISM_PATH,
      failWith: () => notFound(),
      // No pathCommits entries — every probe returns zero commits.
    });
    globalThis.fetch = fetchImpl;

    const data = await callFinalizeAudit();

    const sessionLog = findSessionLog(data);
    expect(sessionLog.exists).toBe(false);
    expect(sessionLog.needs_creation).toBe(true);
    expect(sessionLog.status).toBeUndefined();
    expect(sessionLog.fetch_error).toBeUndefined();
    expect(unverifiedDiagnosticsFor(data, "session-log.md")).toHaveLength(0);

    // INS-31: URL + method. The content fetch 404'd on .prism/ then fell back
    // to the legacy root (also 404) — genuine resolveDocPath behavior.
    const prismAttempts = requestsFor(recorded, SESSION_LOG_PRISM_PATH);
    expect(prismAttempts).toHaveLength(1);
    expect(prismAttempts[0].url).toBe(SESSION_LOG_URL);
    expect(prismAttempts[0].method).toBe("GET");
    expect(requestsFor(recorded, "session-log.md")).toHaveLength(1);

    // Absence was CONFIRMED via the path-filtered commit-history probe at
    // BOTH layouts: GET /commits?path=<doc-path>&per_page=1.
    for (const probePath of [".prism/session-log.md", "session-log.md"]) {
      const probes = historyProbesFor(recorded, probePath);
      expect(probes).toHaveLength(1);
      expect(probes[0].method).toBe("GET");
      expect(new URL(probes[0].url).searchParams.get("per_page")).toBe("1");
    }
  }, 10_000);

  it("P2 inverted: a single 502 on an existing doc → unverified + FINALIZE_AUDIT_UNVERIFIED_DOC diagnostic, NOT needs_creation", async () => {
    const { fetchImpl, recorded } = makeFetchRouter({
      failPath: SESSION_LOG_PRISM_PATH,
      failWith: () => new Response("Bad gateway", { status: 502 }),
      // Path history exists (the doc is live on main) — irrelevant to a non-404,
      // which must classify unverified without needing the probe.
      pathCommits: { ".prism/session-log.md": [commitItem("live-1")] },
    });
    globalThis.fetch = fetchImpl;

    const data = await callFinalizeAudit();

    const sessionLog = findSessionLog(data);
    expect(sessionLog.exists).toBe(false);
    expect(sessionLog.needs_creation).toBe(false);
    expect(sessionLog.status).toBe("unverified");
    expect(sessionLog.fetch_error).toMatch(/502/);

    // The diagnostic names the doc AND the underlying error.
    const diags = unverifiedDiagnosticsFor(data, "session-log.md");
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toMatch(/502/);

    // Counted as neither healthy nor missing; the other nine stay healthy.
    const others = data.audit.living_documents.filter((d: any) => d.file !== "session-log.md");
    expect(others.every((d: any) => d.exists === true)).toBe(true);

    // INS-31: URL + method. One unretried GET (no 5xx retry), and SRV-44
    // held — no legacy-root fallback for an operational error.
    const attempts = requestsFor(recorded, SESSION_LOG_PRISM_PATH);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].url).toBe(SESSION_LOG_URL);
    expect(attempts[0].method).toBe("GET");
    expect(requestsFor(recorded, "session-log.md")).toHaveLength(0);
  }, 10_000);

  it("transient 404 where the path HAS commit history → unverified, NOT needs_creation (probe asserted)", async () => {
    const { fetchImpl, recorded } = makeFetchRouter({
      failPath: SESSION_LOG_PRISM_PATH,
      failWith: () => notFound(),
      pathCommits: { ".prism/session-log.md": [commitItem("605751d")] },
    });
    globalThis.fetch = fetchImpl;

    const data = await callFinalizeAudit();

    const sessionLog = findSessionLog(data);
    expect(sessionLog.exists).toBe(false);
    expect(sessionLog.needs_creation).toBe(false);
    expect(sessionLog.status).toBe("unverified");
    expect(sessionLog.fetch_error).toMatch(/commit history/i);
    expect(unverifiedDiagnosticsFor(data, "session-log.md")).toHaveLength(1);

    // The 404 triggered the confirmation probe (GET, per_page=1, path filter),
    // and the history hit is what blocked the needs_creation classification.
    const probes = historyProbesFor(recorded, ".prism/session-log.md");
    expect(probes).toHaveLength(1);
    expect(probes[0].method).toBe("GET");
    expect(new URL(probes[0].url).searchParams.get("per_page")).toBe("1");
  }, 10_000);

  it("P1 inverted: a 401 outlasting the SRV-35 retries → unverified with the INS-311 error surfaced, NOT needs_creation", async () => {
    const { fetchImpl, recorded } = makeFetchRouter({
      failPath: SESSION_LOG_PRISM_PATH,
      failWith: () => new Response("unauthorized", { status: 401 }),
    });
    globalThis.fetch = fetchImpl;

    const data = await callFinalizeAudit();

    const sessionLog = findSessionLog(data);
    expect(sessionLog.needs_creation).toBe(false);
    expect(sessionLog.status).toBe("unverified");
    expect(sessionLog.fetch_error).toMatch(/401/);
    expect(unverifiedDiagnosticsFor(data, "session-log.md")).toHaveLength(1);

    // The SRV-35 retry budget was spent (three GETs on the same URL) before
    // the failure surfaced as unverified rather than collapsing into absence.
    const attempts = requestsFor(recorded, SESSION_LOG_PRISM_PATH);
    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => a.url === SESSION_LOG_URL && a.method === "GET")).toBe(true);
    expect(requestsFor(recorded, "session-log.md")).toHaveLength(0);
  }, 15_000);
});

// ── Recreate guard: commit refuses to push over an unverifiable doc ────────────

describe("INS-360 fix — commit recreate guard refuses a from-scratch replacement for an unverified doc", () => {
  const FROM_SCRATCH_SESSION_LOG =
    "# Session Log\n\n### Session 191 (2026-07-12)\nRecreated from scratch.\n\n<!-- EOF: session-log.md -->";
  const VALID_HANDOFF = HANDOFF_CONTENT.replace("Handoff Version: 30", "Handoff Version: 31")
    .replace("Session Count: 190", "Session Count: 191");

  it("commit with a living doc whose state is unverifiable (500) → whole commit refused, ZERO write requests issued", async () => {
    const { fetchImpl, recorded } = makeFetchRouter({
      failPath: SESSION_LOG_PRISM_PATH,
      failWith: () => new Response("Internal error", { status: 500 }),
    });
    globalThis.fetch = fetchImpl;

    const data = await callFinalize({
      action: "commit",
      handoff_version: 31,
      files: [
        { path: "handoff.md", content: VALID_HANDOFF },
        { path: "session-log.md", content: FROM_SCRATCH_SESSION_LOG },
      ],
    });

    expect(data.all_succeeded).toBe(false);
    expect(data.confirmation).toMatch(/REFUSED/);
    expect(data.confirmation).toMatch(/INS-360/);

    // The refusal names the blocked doc in its per-file result…
    const sessionLogResult = data.results.find((r: any) => r.path === "session-log.md");
    expect(sessionLogResult.success).toBe(false);
    expect(
      sessionLogResult.validation_errors.some((e: string) => e.includes("FINALIZE_RECREATE_BLOCKED")),
    ).toBe(true);

    // …and as a diagnostic carrying the underlying error.
    const blocked = (data.diagnostics ?? []).filter((d: any) => d.code === "FINALIZE_RECREATE_BLOCKED");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].message).toMatch(/session-log\.md/);
    expect(blocked[0].message).toMatch(/500/);

    // INS-31 + the core guarantee: NO write of any kind reached GitHub —
    // no contents PUT, no git-data POST/PATCH, no DELETE. Reads only.
    const writes = recorded.filter((r) => r.method !== "GET");
    expect(writes).toEqual([]);
  }, 15_000);

  it("commit refuses when the doc 404s but the path has commit history (deleted/flaked doc is not silently recreated)", async () => {
    const { fetchImpl, recorded } = makeFetchRouter({
      failPath: SESSION_LOG_PRISM_PATH,
      failWith: () => notFound(),
      pathCommits: { ".prism/session-log.md": [commitItem("605751d")] },
    });
    globalThis.fetch = fetchImpl;

    const data = await callFinalize({
      action: "commit",
      handoff_version: 31,
      files: [
        { path: "handoff.md", content: VALID_HANDOFF },
        { path: "session-log.md", content: FROM_SCRATCH_SESSION_LOG },
      ],
    });

    expect(data.all_succeeded).toBe(false);
    expect(data.confirmation).toMatch(/REFUSED/);
    const blocked = (data.diagnostics ?? []).filter((d: any) => d.code === "FINALIZE_RECREATE_BLOCKED");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].message).toMatch(/commit history/i);

    // The guard consulted the path-filtered history probe before refusing.
    expect(historyProbesFor(recorded, ".prism/session-log.md").length).toBeGreaterThanOrEqual(1);

    // Zero writes.
    expect(recorded.filter((r) => r.method !== "GET")).toEqual([]);
  }, 15_000);
});
