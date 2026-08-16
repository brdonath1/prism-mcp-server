/**
 * S208 PR-S2a - the latency + robustness half:
 *   MCP-2  prism_load_rules wall-clock deadline
 *   MCP-14 GITHUB_RETRY_BUDGET_MS bounds TOTAL elapsed attempt time
 *   MCP-15 KI-28 living docs redirect root -> .prism/
 *   MCP-16 boot-test push path is cached per repo
 *   item 8 archive body resolution for pointer stubs
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../src/utils/doc-resolver.js", () => {
  const resolveDocPath = vi.fn();
  return {
    resolveDocPath,
    resolveRuleSourceDoc: vi.fn(),
    resolveDocPushPath: vi.fn(),
    resolveDocExists: vi.fn(),
    resolveDocFiles: vi.fn(),
  };
});

import { registerLoadRules } from "../src/tools/load-rules.js";
import { resolveRuleSourceDoc, resolveDocPushPath } from "../src/utils/doc-resolver.js";
import { LOAD_RULES_WALL_CLOCK_DEADLINE_MS, MCP_SAFE_TIMEOUT } from "../src/config.js";
import { KNOWN_PRISM_PATHS } from "../src/utils/doc-guard.js";
import {
  isArchiveBodyStub,
  resolveArchivedRuleBodies,
  type StandingRule,
} from "../src/utils/standing-rules.js";
import { clearStandingRulesParseCache } from "../src/utils/standing-rules-union.js";

const mockResolveRuleSource = vi.mocked(resolveRuleSourceDoc);
const mockResolveDocPushPath = vi.mocked(resolveDocPushPath);

function createServerStub() {
  const handlers: Record<string, Function> = {};
  return {
    server: {
      tool(name: string, _d: unknown, _s: unknown, handler: Function) {
        handlers[name] = handler;
      },
    },
    handlers,
  };
}

function loadRulesHandler() {
  const { server, handlers } = createServerStub();
  registerLoadRules(server as never);
  return handlers.prism_load_rules;
}

/** A rule source containing one rule with the given body. */
function registryDoc(id: string, body: string, tier: "A" | "B" | "C" = "B"): string {
  return [
    "# Standing Rules",
    "",
    `### ${id}: A rule [TIER:${tier}]`,
    "<!-- topics: latency -->",
    "",
    body,
    "",
    "<!-- EOF: standing-rules.md -->",
  ].join("\n");
}

function ruleSource(content: string, sha: string, path = ".prism/standing-rules.md") {
  return { path, content, sha, legacy: false, notModified: false };
}

// -- MCP-2: prism_load_rules wall-clock deadline -----------------------------

describe("MCP-2 - prism_load_rules wall-clock deadline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearStandingRulesParseCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to MCP_SAFE_TIMEOUT so the structured error beats the transport", () => {
    expect(LOAD_RULES_WALL_CLOCK_DEADLINE_MS).toBe(MCP_SAFE_TIMEOUT);
  });

  it("returns a structured DEADLINE_EXCEEDED response when a rule source hangs", async () => {
    // A rule fetch that never settles - the exact failure the deadline exists
    // for. Pre-MCP-2 this held the client to the ~60s transport timeout with
    // nothing structured to show. Fake timers drive the REAL default deadline
    // instead of re-importing the module graph under a shortened env value.
    vi.useFakeTimers();
    mockResolveRuleSource.mockImplementation(() => new Promise(() => {}));

    const handler = loadRulesHandler();
    const pending = handler({ project_slug: "prism", topic: "latency" });
    await vi.advanceTimersByTimeAsync(LOAD_RULES_WALL_CLOCK_DEADLINE_MS + 10);
    const result = await pending;
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(payload.code).toBe("DEADLINE_EXCEEDED");
    expect(payload.error).toMatch(/deadline exceeded/i);
    expect(payload.project).toBe("prism");
  });

  it("clears the deadline timer on the fast path (no timer is left armed)", async () => {
    vi.useFakeTimers();
    mockResolveRuleSource.mockImplementation(async (_slug: string, docName: string) => {
      if (docName === "standing-rules.md") {
        return ruleSource(registryDoc("INS-1", "**Standing procedure:** Do it."), "sr-1");
      }
      throw new Error("Not found: insights.md");
    });

    const handler = loadRulesHandler();
    await handler({ project_slug: "prism", topic: "latency" });

    expect(vi.getTimerCount()).toBe(0);
  });

  it("a fast call still returns the normal payload (the race adds nothing)", async () => {
    mockResolveRuleSource.mockImplementation(async (_slug: string, docName: string) => {
      if (docName === "standing-rules.md") {
        return ruleSource(registryDoc("INS-1", "**Standing procedure:** Do it."), "sr-1");
      }
      throw new Error("Not found: insights.md");
    });

    const handler = loadRulesHandler();
    const result = await handler({ project_slug: "prism", topic: "latency" });
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBeUndefined();
    expect(payload.matched_rules.map((r: StandingRule) => r.id)).toEqual(["INS-1"]);
  });
});

// -- item 8: archive body resolution ----------------------------------------

describe("PR-S2a item 8 - archive body pointer stubs", () => {
  const stub = (procedure: string): StandingRule => ({
    id: "INS-500",
    title: "Moved rule",
    procedure,
    tier: "B",
    topics: ["latency"],
  });

  it("recognizes the pointer grammar (bare, bold, .prism/-prefixed, anchored)", () => {
    expect(isArchiveBodyStub(stub("Body: standing-rules-archive.md"))).toBe(true);
    expect(isArchiveBodyStub(stub("**Body:** standing-rules-archive.md"))).toBe(true);
    expect(isArchiveBodyStub(stub("Body: .prism/standing-rules-archive.md"))).toBe(true);
    expect(isArchiveBodyStub(stub("Body: standing-rules-archive.md#ins-500"))).toBe(true);
    expect(isArchiveBodyStub(stub("body: STANDING-RULES-ARCHIVE.MD"))).toBe(true);
  });

  it("does NOT treat a real body that merely mentions the archive as a stub", () => {
    expect(
      isArchiveBodyStub(
        stub("**Standing procedure:** Move retired bodies to standing-rules-archive.md."),
      ),
    ).toBe(false);
    expect(
      isArchiveBodyStub(stub("Body: standing-rules-archive.md\n\nAnd then do something else.")),
    ).toBe(false);
  });

  it("splices the archived body in, keeping the stub's id/title/tier", () => {
    const archive = [
      "# Standing Rules Archive",
      "",
      "### INS-500: Moved rule [TIER:B]",
      "<!-- topics: archived_topic -->",
      "",
      "**Standing procedure:** The full original body.",
      "",
      "<!-- EOF: standing-rules-archive.md -->",
    ].join("\n");

    const out = resolveArchivedRuleBodies([stub("Body: standing-rules-archive.md")], archive);

    expect(out.resolved).toEqual(["INS-500"]);
    expect(out.unresolved).toEqual([]);
    expect(out.rules[0].procedure).toBe("The full original body.");
    expect(out.rules[0].id).toBe("INS-500");
    expect(out.rules[0].tier).toBe("B");
    // The stub declared topics, so the stub's topics keep controlling matching.
    expect(out.rules[0].topics).toEqual(["latency"]);
  });

  it("inherits the archive's topics when the stub declares none", () => {
    const archive = [
      "### INS-500: Moved rule [TIER:B]",
      "<!-- topics: archived_topic -->",
      "",
      "**Standing procedure:** Body.",
      "",
      "<!-- EOF: standing-rules-archive.md -->",
    ].join("\n");

    const bare: StandingRule = { ...stub("Body: standing-rules-archive.md"), topics: [] };
    const out = resolveArchivedRuleBodies([bare], archive);
    expect(out.rules[0].topics).toEqual(["archived_topic"]);
  });

  it("reports an unresolvable stub instead of silently shipping the pointer", () => {
    const out = resolveArchivedRuleBodies([stub("Body: standing-rules-archive.md")], null);
    expect(out.resolved).toEqual([]);
    expect(out.unresolved).toEqual(["INS-500"]);
    expect(out.rules[0].procedure).toBe("Body: standing-rules-archive.md");
  });

  it("leaves non-stub rules untouched", () => {
    const real = stub("**Standing procedure:** A real body.");
    const out = resolveArchivedRuleBodies([real], "### INS-500: x\n\n**Standing procedure:** other");
    expect(out.rules[0]).toBe(real);
    expect(out.resolved).toEqual([]);
  });
});

describe("PR-S2a item 8 - prism_load_rules resolves stub bodies end to end", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearStandingRulesParseCache();
  });

  it("fetches the archive and serves the full body, with a resolved diagnostic", async () => {
    mockResolveRuleSource.mockImplementation(async (_slug: string, docName: string) => {
      if (docName === "standing-rules.md") {
        return ruleSource(registryDoc("INS-500", "Body: standing-rules-archive.md"), "sr-stub");
      }
      if (docName === "standing-rules-archive.md") {
        return ruleSource(
          registryDoc("INS-500", "**Standing procedure:** The archived body."),
          "arch-1",
          ".prism/standing-rules-archive.md",
        );
      }
      throw new Error("Not found: insights.md");
    });

    const handler = loadRulesHandler();
    const result = await handler({ project_slug: "prism", topic: "latency" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.matched_rules[0].procedure).toBe("The archived body.");
    expect(payload.diagnostics.map((d: { code: string }) => d.code)).toContain(
      "STANDING_RULE_ARCHIVE_BODY_RESOLVED",
    );
  });

  it("never reads the archive when no matched rule is a stub (inert today)", async () => {
    mockResolveRuleSource.mockImplementation(async (_slug: string, docName: string) => {
      if (docName === "standing-rules.md") {
        return ruleSource(registryDoc("INS-1", "**Standing procedure:** Inline body."), "sr-1");
      }
      throw new Error("Not found");
    });

    const handler = loadRulesHandler();
    await handler({ project_slug: "prism", topic: "latency" });

    const requested = mockResolveRuleSource.mock.calls.map((c) => c[1]);
    expect(requested).not.toContain("standing-rules-archive.md");
  });

  it("warns (and still answers) when the archive itself is unavailable", async () => {
    mockResolveRuleSource.mockImplementation(async (_slug: string, docName: string) => {
      if (docName === "standing-rules.md") {
        return ruleSource(registryDoc("INS-500", "Body: standing-rules-archive.md"), "sr-stub");
      }
      throw new Error("Not found: " + docName);
    });

    const handler = loadRulesHandler();
    const result = await handler({ project_slug: "prism", topic: "latency" });
    const payload = JSON.parse(result.content[0].text);
    const codes = payload.diagnostics.map((d: { code: string }) => d.code);

    expect(result.isError).toBeUndefined();
    expect(codes).toContain("STANDING_RULES_ARCHIVE_UNAVAILABLE");
    expect(codes).toContain("STANDING_RULE_ARCHIVE_BODY_MISSING");
    expect(payload.matched_rules[0].procedure).toBe("Body: standing-rules-archive.md");
  });
});

// -- MCP-15: KI-28 doc-guard paths ------------------------------------------

describe("MCP-15 - KNOWN_PRISM_PATHS covers the KI-28 living docs", () => {
  // The exact docs KI-28 named plus the archives that live beside them. A bare
  // push of any of these used to create a root-level duplicate.
  const KI28_DOCS = [
    "audit-trail.md",
    "pending-doc-updates.md",
    "audit-harness.md",
    "standing-rules-archive.md",
    "pending-doc-updates-archive.md",
  ];

  it.each(KI28_DOCS)("%s is a known PRISM living-doc path", (doc) => {
    expect(KNOWN_PRISM_PATHS).toContain(doc);
  });

  it("keeps the pre-existing entries (no accidental removals)", () => {
    for (const doc of [
      "handoff.md",
      "decisions/_INDEX.md",
      "session-log.md",
      "task-queue.md",
      "eliminated.md",
      "architecture.md",
      "glossary.md",
      "known-issues.md",
      "insights.md",
      "intelligence-brief.md",
      "boot-test.md",
      "standing-rules.md",
      "session-log-archive.md",
      "known-issues-archive.md",
      "build-history-archive.md",
      "insights-archive.md",
    ]) {
      expect(KNOWN_PRISM_PATHS).toContain(doc);
    }
  });

  it("has no duplicate entries", () => {
    expect(new Set(KNOWN_PRISM_PATHS).size).toBe(KNOWN_PRISM_PATHS.length);
  });
});

describe("MCP-15 - guardPushPath redirects a bare KI-28 doc to .prism/", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("audit-trail.md (the S179 repro) is redirected, not written to the root", async () => {
    mockResolveDocPushPath.mockResolvedValue(".prism/audit-trail.md");
    const { guardPushPath } = await import("../src/utils/doc-guard.js");

    const result = await guardPushPath("prism", "audit-trail.md");

    expect(result).toEqual({ path: ".prism/audit-trail.md", redirected: true });
    expect(mockResolveDocPushPath).toHaveBeenCalledWith("prism", "audit-trail.md");
  });

  it("a genuinely unrelated root file is still left alone", async () => {
    const { guardPushPath } = await import("../src/utils/doc-guard.js");
    const result = await guardPushPath("prism", "CHANGELOG.md");
    expect(result).toEqual({ path: "CHANGELOG.md", redirected: false });
    expect(mockResolveDocPushPath).not.toHaveBeenCalled();
  });
});

// -- MCP-14 / MCP-16: source-level contracts --------------------------------

describe("MCP-14 - attempts stop when the budget is exhausted", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.GITHUB_RETRY_BUDGET_MS;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("stops retrying once the SLOW ATTEMPTS have consumed the budget", async () => {
    // The pre-MCP-14 hole: only the backoff SLEEP was budget-checked. With a
    // zero Retry-After every sleep trivially "fits", so a chain of slow-but-
    // not-timed-out attempts ran the full maxRetries and blew past the budget.
    // Here each attempt burns 300ms against a 700ms budget: attempt 0 and one
    // retry fit; the third is refused because the budget - not the sleep - is
    // spent.
    vi.resetModules();
    process.env.GITHUB_RETRY_BUDGET_MS = "700";
    const { fetchWithRetry } = await import("../src/github/client.js");

    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }) as unknown as typeof fetch;

    const start = Date.now();
    await expect(fetchWithRetry("https://api.github.com/x")).rejects.toThrow(
      /retry budget exhausted/i,
    );
    const elapsed = Date.now() - start;

    expect(calls).toBe(2);
    // Total elapsed is bounded by the budget, which is the whole claim.
    expect(elapsed).toBeLessThan(1_500);
  }, 10_000);

  it("the budget-exhausted throw preserves the last response's status and Retry-After (S2A-B1)", async () => {
    // Pre-S2A-B1: this throw was a bare "budget exhausted" message with no
    // trace of WHY the retries were happening -- the pre-sleep
    // `retryFitsBudget` path returns the last response (status + headers
    // intact) to its caller, but this parallel exhausted-BEFORE-next-attempt
    // throw carried none of that. Same fixture shape as the test above: two
    // 300ms 429 responses with retry-after "0" against a 700ms budget, so the
    // third attempt is refused before it starts and the last SEEN response
    // (attempt 1's 429 / retry-after "0") must be reflected in the error.
    vi.resetModules();
    process.env.GITHUB_RETRY_BUDGET_MS = "700";
    const { fetchWithRetry } = await import("../src/github/client.js");

    globalThis.fetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0" },
      });
    }) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await fetchWithRetry("https://api.github.com/x");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { lastStatus?: number; retryAfter?: string | null };
    expect(err.message).toMatch(/retry budget exhausted/i);
    expect(err.message).toContain("429");
    expect(err.message).toContain("Retry-After: 0");
    expect(err.lastStatus).toBe(429);
    expect(err.retryAfter).toBe("0");
  }, 10_000);

  it("a single fast attempt is completely unaffected", async () => {
    vi.resetModules();
    process.env.GITHUB_RETRY_BUDGET_MS = "700";
    const { fetchWithRetry } = await import("../src/github/client.js");

    globalThis.fetch = vi.fn(async () =>
      new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;

    const res = await fetchWithRetry("https://api.github.com/x");
    expect(res.status).toBe(200);
  });
});

describe("MCP-14 - the retry budget bounds total elapsed attempt time", () => {
  const source = readFileSync("src/github/client.ts", "utf-8");

  it("refuses to start a retry once the remaining budget is spent", () => {
    expect(source).toContain("const budgetRemaining = retryDeadline - Date.now();");
    expect(source).toContain("attempt > 0 && budgetRemaining < MIN_RETRY_ATTEMPT_MS");
    expect(source).toContain("GitHub retry budget exhausted after");
  });

  it("clamps each RETRY's per-request timeout to the remaining budget", () => {
    expect(source).toContain("Math.min(GITHUB_REQUEST_TIMEOUT_MS, budgetRemaining)");
    // The first attempt keeps the full per-request timeout: the non-retry path
    // must be byte-for-byte the old behavior.
    expect(source).toContain("attempt === 0\n        ? GITHUB_REQUEST_TIMEOUT_MS");
  });
});

describe("PR-S2a - the payload-byte-identity harness is a committed artifact", () => {
  // The "payload-byte-identical" claim is only as durable as the tool that
  // proves it. This guards the artifact itself: a gate that names a script
  // nobody can run is not a gate.
  const harness = readFileSync("scripts/measure-boot-payload.mjs", "utf-8");

  it("bundles the server's own bootstrap rather than re-implementing it", () => {
    expect(harness).toContain("registerBootstrap");
    expect(harness).toContain("--bundle");
  });

  it("measures delivered bytes and reports per-field attribution", () => {
    expect(harness).toContain("delivered_payload_bytes");
    expect(harness).toContain("field_bytes");
  });

  it("freezes the clock, without which no two runs could be compared", () => {
    expect(harness).toContain("FROZEN_INSTANT_MS");
  });
});

describe("MCP-16 - the boot-test push path is cached per repo", () => {
  const source = readFileSync("src/tools/bootstrap.ts", "utf-8");

  it("skips resolveDocPushPath when a cached path exists", () => {
    expect(source).toContain("const cachedPath = bootTestPathCache.get(pathCacheKey);");
    expect(source).toContain(
      'const bootTestPath = cachedPath ?? (await resolveDocPushPath(slug, "boot-test.md"));',
    );
  });

  it("invalidates the cached path whenever the push does not succeed", () => {
    expect(source).toContain("bootTestPathCache.set(pathCacheKey, bootTestPath);");
    expect(source).toContain("bootTestPathCache.invalidate(pathCacheKey);");
  });
});

describe("S2A-B1 - the boot-test path cache only self-heals through canonical resolutions", () => {
  // Behavioral coverage (not source-text matching) for the S2A-B1 blocker fix:
  // resolveDocPushPath's answer is cached ONLY when it resolves under
  // DOC_ROOT. A legacy-root resolution must never be cached -- caching it
  // would let a repo latch onto the stale root path forever, since a push to
  // the legacy root keeps SUCCEEDING right up until the repo migrates, so a
  // failed-push invalidation alone would never fire to unstick it.
  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(async () => {
    const { bootTestPathCache } = await import("../src/utils/cache.js");
    bootTestPathCache.clear();
    vi.restoreAllMocks();
  });

  it("never caches a legacy-root resolution, so the repo re-probes on every boot", async () => {
    const doc = await import("../src/utils/doc-resolver.js");
    const clientMod = await import("../src/github/client.js");
    const { bootTestPathCache } = await import("../src/utils/cache.js");
    const { pushBootTest } = await import("../src/tools/bootstrap.js");

    const resolvePushPath = vi.mocked(doc.resolveDocPushPath);
    // vi.spyOn (not vi.mock) so `fetchWithRetry` in the sibling MCP-14
    // describes above keeps its real implementation untouched -- pushBootTest
    // never calls fetchWithRetry itself, only pushFile.
    const push = vi.spyOn(clientMod, "pushFile");
    resolvePushPath.mockResolvedValue("boot-test.md"); // legacy root, file lives there
    push.mockResolvedValue({ success: true, size: 100, sha: "sha-legacy" });

    const first = await pushBootTest("prism", 208, "2026-08-16T00:00:00Z", 12);
    expect(first.success).toBe(true);
    expect(resolvePushPath).toHaveBeenCalledTimes(1);
    // Nothing cached: a legacy-root resolution is never written to the cache.
    expect(bootTestPathCache.get("prism:boot-test.md")).toBeNull();

    const second = await pushBootTest("prism", 209, "2026-08-16T01:00:00Z", 12);
    expect(second.success).toBe(true);
    // Re-probed on the next boot rather than reusing a cached legacy path.
    expect(resolvePushPath).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenNthCalledWith(
      2,
      "prism",
      "boot-test.md",
      expect.any(String),
      expect.any(String),
    );
  });

  it("caches a canonical resolution and skips the probe on the next boot", async () => {
    const doc = await import("../src/utils/doc-resolver.js");
    const clientMod = await import("../src/github/client.js");
    const { bootTestPathCache } = await import("../src/utils/cache.js");
    const { pushBootTest } = await import("../src/tools/bootstrap.js");
    const { DOC_ROOT } = await import("../src/config.js");

    const resolvePushPath = vi.mocked(doc.resolveDocPushPath);
    const push = vi.spyOn(clientMod, "pushFile");
    resolvePushPath.mockResolvedValue(`${DOC_ROOT}/boot-test.md`); // migrated repo
    push.mockResolvedValue({ success: true, size: 100, sha: "sha-canonical" });

    const first = await pushBootTest("prism", 208, "2026-08-16T00:00:00Z", 12);
    expect(first.success).toBe(true);
    expect(resolvePushPath).toHaveBeenCalledTimes(1);
    expect(bootTestPathCache.get("prism:boot-test.md")).toBe(`${DOC_ROOT}/boot-test.md`);

    const second = await pushBootTest("prism", 209, "2026-08-16T01:00:00Z", 12);
    expect(second.success).toBe(true);
    // Cached: resolveDocPushPath is NOT called again on the second boot.
    expect(resolvePushPath).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenNthCalledWith(
      2,
      "prism",
      `${DOC_ROOT}/boot-test.md`,
      expect.any(String),
      expect.any(String),
    );
  });

  it("stops caching a repo that migrates away from a stale cached canonical path only via a failed push (backstop)", async () => {
    const doc = await import("../src/utils/doc-resolver.js");
    const clientMod = await import("../src/github/client.js");
    const { bootTestPathCache } = await import("../src/utils/cache.js");
    const { pushBootTest } = await import("../src/tools/bootstrap.js");
    const { DOC_ROOT } = await import("../src/config.js");

    const resolvePushPath = vi.mocked(doc.resolveDocPushPath);
    const push = vi.spyOn(clientMod, "pushFile");
    resolvePushPath.mockResolvedValue(`${DOC_ROOT}/boot-test.md`);
    push.mockResolvedValue({ success: true, size: 100, sha: "sha-canonical" });

    await pushBootTest("prism", 208, "2026-08-16T00:00:00Z", 12);
    expect(bootTestPathCache.get("prism:boot-test.md")).toBe(`${DOC_ROOT}/boot-test.md`);

    // Cached path push now fails (e.g. the repo's write scope was pulled).
    push.mockResolvedValue({ success: false, size: 0, sha: "", error: "403 scope loss" });
    const failed = await pushBootTest("prism", 209, "2026-08-16T01:00:00Z", 12);
    expect(failed.success).toBe(false);
    // The cached-path fetch was reused (no re-probe before the failing push)...
    expect(resolvePushPath).toHaveBeenCalledTimes(1);
    // ...but the failure invalidates the entry as the backstop.
    expect(bootTestPathCache.get("prism:boot-test.md")).toBeNull();
  });
});
