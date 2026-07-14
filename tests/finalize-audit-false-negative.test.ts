/**
 * INS-360 (brief-s195b) — finalize-audit false-negative CHARACTERIZATION tests.
 *
 * These tests pin the CURRENT (defective) behavior root-caused in
 * docs/rca/ins-360-finalize-audit-false-negative.md: a non-404 operational
 * failure (transient 401, 5xx, 403, oversize/empty content) on a living-doc
 * read is rethrown by resolveDocPath (SRV-44) but then silently swallowed by
 * resolveDocFiles' fulfilled-only Promise.allSettled loop
 * (src/utils/doc-resolver.ts:121-126), so auditPhase classifies a file that
 * EXISTS on main as `exists: false, needs_creation: true`
 * (src/tools/finalize.ts:227-236) with no warning or diagnostic.
 *
 * This is the S191 incident mechanism: `.prism/session-log.md` existed on
 * brdonath1/prism main, the audit reported needs_creation, and the finalize
 * commit then overwrote it.
 *
 * INS-177 audit-then-fix: the assertions below are deliberately GREEN on the
 * buggy behavior. The follow-up fix brief MUST invert them (error → visible
 * fetch-failure classification, never needs_creation). Path IDs (P1, P2, P5,
 * P8) refer to the misclassification table in the RCA doc.
 *
 * Mock style: globalThis.fetch with URL + method assertions (INS-31 pattern,
 * mirroring tests/github-transient-errors.test.ts) so the REAL
 * fetchWithRetry → fetchFile → resolveDocPath → resolveDocFiles chain runs.
 */

// Set dummy PAT to prevent config.ts from calling process.exit(1) during import.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveDocFiles } from "../src/utils/doc-resolver.js";
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
 * Route every GitHub API URL the audit path touches. The doc at `failPath`
 * (a `.prism/`-prefixed contents path) answers with `failWith(callNumber)`;
 * all other living docs resolve; handoff-history, legacy-root fallbacks, and
 * the framework rules template 404; the commits listing returns [].
 */
function makeAuditFetchRouter(
  failPath: string,
  failWith: (call: number) => Response,
): { fetchImpl: typeof fetch; recorded: RecordedRequest[] } {
  const recorded: RecordedRequest[] = [];
  let failCalls = 0;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    recorded.push({ url: u, method: (init?.method ?? "GET").toUpperCase() });
    if (u.includes(`/contents/${failPath}`)) {
      failCalls += 1;
      return failWith(failCalls);
    }
    if (u.includes("/commits?")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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

/** Invoke prism_finalize via the McpServer internal handler (integration-test pattern). */
async function callFinalizeAudit(): Promise<any> {
  const server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerFinalize(server);
  const tool = (server as any)._registeredTools["prism_finalize"];
  if (!tool) throw new Error("Tool not registered");
  const result = await tool.handler(
    { project_slug: "test-project", action: "audit", session_number: 191 },
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

const SESSION_LOG_PRISM_PATH = ".prism/session-log.md";
const SESSION_LOG_URL =
  "https://api.github.com/repos/test-owner/test-project/contents/.prism/session-log.md";

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ── Drop locus: resolveDocFiles swallows operational rejections ────────────────

describe("INS-360 characterization — resolveDocFiles silently drops operational failures (doc-resolver.ts:121-126)", () => {
  it("P2: a single 502 on the .prism/ read drops the doc from the map — one attempt, no retry, no root fallback, no error surfaced", async () => {
    const { fetchImpl, recorded } = makeAuditFetchRouter(
      SESSION_LOG_PRISM_PATH,
      () => new Response("Bad gateway", { status: 502 }),
    );
    globalThis.fetch = fetchImpl;

    const map = await resolveDocFiles("test-project", ["handoff.md", "session-log.md"]);

    // The healthy doc resolves; the 502'd doc is SILENTLY absent (the bug —
    // the rejection carried "GitHub API 502" but the caller cannot see it).
    expect(map.has("handoff.md")).toBe(true);
    expect(map.has("session-log.md")).toBe(false);

    // INS-31: URL + method. Exactly ONE attempt — fetchWithRetry has no 5xx
    // retry (client.ts:167-230), so a single gateway blip is terminal.
    const attempts = requestsFor(recorded, SESSION_LOG_PRISM_PATH);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].url).toBe(SESSION_LOG_URL);
    expect(attempts[0].method).toBe("GET");

    // SRV-44 held: the operational error did NOT fall back to the legacy root
    // path — the rejection died in resolveDocFiles, not in a wrong fallback.
    expect(requestsFor(recorded, "session-log.md")).toHaveLength(0);
  }, 10_000);

  it("P5: a non-rate-limit 403 drops the doc from the map — single attempt, no root fallback", async () => {
    const { fetchImpl, recorded } = makeAuditFetchRouter(
      SESSION_LOG_PRISM_PATH,
      () => new Response("Resource not accessible by integration", { status: 403 }),
    );
    globalThis.fetch = fetchImpl;

    const map = await resolveDocFiles("test-project", ["handoff.md", "session-log.md"]);

    expect(map.has("handoff.md")).toBe(true);
    expect(map.has("session-log.md")).toBe(false);

    const attempts = requestsFor(recorded, SESSION_LOG_PRISM_PATH);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].url).toBe(SESSION_LOG_URL);
    expect(attempts[0].method).toBe("GET");
    expect(requestsFor(recorded, "session-log.md")).toHaveLength(0);
  }, 10_000);

  it("P8: a 200 with empty content (empty file / >1MB truncation shape) drops the doc from the map", async () => {
    const { fetchImpl, recorded } = makeAuditFetchRouter(SESSION_LOG_PRISM_PATH, () =>
      new Response(JSON.stringify({ content: "", sha: "big-sha", size: 2_000_000 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchImpl;

    const map = await resolveDocFiles("test-project", ["handoff.md", "session-log.md"]);

    // fetchFile throws "No content returned…" (client.ts:258-260); the message
    // does not match /Not found/i, so resolveDocPath rethrows and
    // resolveDocFiles drops the doc — an EXISTING oversize doc reads as absent.
    expect(map.has("handoff.md")).toBe(true);
    expect(map.has("session-log.md")).toBe(false);

    const attempts = requestsFor(recorded, SESSION_LOG_PRISM_PATH);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].method).toBe("GET");
    expect(requestsFor(recorded, "session-log.md")).toHaveLength(0);
  }, 10_000);
});

// ── S191 symptom: audit reports needs_creation for a live file ─────────────────

describe("INS-360 characterization — prism_finalize action=audit misreports an existing doc as needs_creation (finalize.ts:227-236)", () => {
  it("P2: a single 502 on .prism/session-log.md → audit returns exists:false, needs_creation:true, and NO warning or diagnostic mentions the failure", async () => {
    const { fetchImpl, recorded } = makeAuditFetchRouter(
      SESSION_LOG_PRISM_PATH,
      () => new Response("Bad gateway", { status: 502 }),
    );
    globalThis.fetch = fetchImpl;

    const data = await callFinalizeAudit();

    // The S191 shape: exactly one of the 10 living documents misclassified.
    expect(data.audit.living_documents).toHaveLength(LIVING_DOCUMENT_NAMES.length);
    const sessionLog = data.audit.living_documents.find(
      (d: any) => d.file === "session-log.md",
    );
    expect(sessionLog.exists).toBe(false);
    expect(sessionLog.needs_creation).toBe(true);
    const others = data.audit.living_documents.filter(
      (d: any) => d.file !== "session-log.md",
    );
    expect(others.every((d: any) => d.exists === true)).toBe(true);

    // The visibility gap: the fetch failure surfaces NOWHERE in the response.
    const warnings: string[] = data.audit.warnings;
    expect(warnings.some((w) => /session-log|502|fetch/i.test(w))).toBe(false);
    const diagnostics: Array<{ message?: string }> = data.diagnostics ?? [];
    expect(diagnostics.some((d) => /session-log/i.test(d.message ?? ""))).toBe(false);

    // INS-31: URL + method, single unretried attempt.
    const attempts = requestsFor(recorded, SESSION_LOG_PRISM_PATH);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].url).toBe(SESSION_LOG_URL);
    expect(attempts[0].method).toBe("GET");
  }, 15_000);

  it("P1: a 401 persisting past the SRV-35 bounded retries → audit returns needs_creation:true for the live doc (INS-311 shape)", async () => {
    const { fetchImpl, recorded } = makeAuditFetchRouter(
      SESSION_LOG_PRISM_PATH,
      () => new Response("unauthorized", { status: 401 }),
    );
    globalThis.fetch = fetchImpl;

    const data = await callFinalizeAudit();

    const sessionLog = data.audit.living_documents.find(
      (d: any) => d.file === "session-log.md",
    );
    expect(sessionLog.exists).toBe(false);
    expect(sessionLog.needs_creation).toBe(true);
    expect(
      data.audit.living_documents
        .filter((d: any) => d.file !== "session-log.md")
        .every((d: any) => d.exists === true),
    ).toBe(true);
    expect(data.audit.warnings.some((w: string) => /session-log|401/i.test(w))).toBe(false);

    // The SRV-35 retry budget (MAX_TRANSIENT_401_RETRIES = 2) was spent —
    // three GET attempts on the same URL — and the sustained blip still
    // collapsed into needs_creation instead of a visible fetch failure.
    const attempts = requestsFor(recorded, SESSION_LOG_PRISM_PATH);
    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => a.url === SESSION_LOG_URL && a.method === "GET")).toBe(true);

    // No root-fallback read was attempted (SRV-44 rethrow, then silent drop).
    expect(requestsFor(recorded, "session-log.md")).toHaveLength(0);
  }, 15_000);
});
