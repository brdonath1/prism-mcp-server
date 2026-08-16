/**
 * S208 PR-S2a (MCP-1) - sha/ETag-conditional rule-source cache + sha-keyed
 * standing-rule parse cache.
 *
 * The load-bearing claim these tests pin is NOT "the cache is fast" but "the
 * cache can never serve a body GitHub has not just certified". Every hit
 * round-trips with `If-None-Match`; only a 304 authorizes serving the cached
 * copy. So the tests assert on the WIRE (which requests carry the validator,
 * which responses carry a body) and on the CONTENT (a changed document is
 * always observed), not merely on hit counts.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchFileConditional } from "../src/github/client.js";
import { resolveRuleSourceDoc } from "../src/utils/doc-resolver.js";
import { MemoryCache, ruleSourceCache } from "../src/utils/cache.js";
import {
  clearStandingRulesParseCache,
  unionStandingRules,
  unionStandingRulesCached,
} from "../src/utils/standing-rules-union.js";

/** One `### INS-N` registry section, rendered the way the parser expects. */
function ruleDoc(id: string, procedure: string, tier: "A" | "B" | "C" = "A"): string {
  return [
    "# Standing Rules",
    "",
    `### ${id}: A rule [TIER:${tier}]`,
    "",
    `**Standing procedure:** ${procedure}`,
    "",
    "<!-- EOF: standing-rules.md -->",
  ].join("\n");
}

function contentsResponse(content: string, sha: string, etag: string | null): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (etag) headers.etag = etag;
  return new Response(
    JSON.stringify({
      content: Buffer.from(content, "utf-8").toString("base64"),
      sha,
      size: Buffer.byteLength(content, "utf-8"),
    }),
    { status: 200, headers },
  );
}

function notFoundResponse(): Response {
  return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
}

interface RecordedRequest {
  url: string;
  ifNoneMatch: string | null;
}

/**
 * Install a fake GitHub that answers from a path -> {content, sha, etag} map
 * and honors conditional requests the way the Contents API does.
 */
function installFakeGitHub(
  files: Map<string, { content: string; sha: string; etag: string | null }>,
): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const ifNoneMatch = headers["If-None-Match"] ?? null;
    requests.push({ url: href, ifNoneMatch });

    const match = [...files.entries()].find(([path]) => href.endsWith(`/contents/${path}`));
    if (!match) return notFoundResponse();

    const [, file] = match;
    if (ifNoneMatch && file.etag && ifNoneMatch === file.etag) {
      return new Response(null, { status: 304 });
    }
    return contentsResponse(file.content, file.sha, file.etag);
  }) as unknown as typeof fetch;
  return requests;
}

describe("MCP-1 - fetchFileConditional", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    ruleSourceCache.clear();
    clearStandingRulesParseCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("sends no If-None-Match without an ETag and returns content + etag", async () => {
    const requests = installFakeGitHub(
      new Map([[".prism/insights.md", { content: "body", sha: "sha-1", etag: '"e1"' }]]),
    );

    const result = await fetchFileConditional("repo", ".prism/insights.md");

    expect(requests[0].ifNoneMatch).toBeNull();
    expect(result).toEqual({
      status: "ok",
      content: "body",
      sha: "sha-1",
      size: 4,
      etag: '"e1"',
    });
  });

  it("returns not_modified (and no body) when the server answers 304", async () => {
    installFakeGitHub(
      new Map([[".prism/insights.md", { content: "body", sha: "sha-1", etag: '"e1"' }]]),
    );

    const result = await fetchFileConditional("repo", ".prism/insights.md", '"e1"');

    expect(result).toEqual({ status: "not_modified" });
  });

  it("still throws the normal Not-found error on 404, so SRV-44 discrimination survives", async () => {
    installFakeGitHub(new Map());
    await expect(fetchFileConditional("repo", ".prism/insights.md", '"e1"')).rejects.toThrow(
      /Not found/,
    );
  });
});

describe("MCP-1 - resolveRuleSourceDoc", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    ruleSourceCache.clear();
    clearStandingRulesParseCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("second read revalidates with If-None-Match and serves the cached body on 304", async () => {
    const requests = installFakeGitHub(
      new Map([
        [".prism/standing-rules.md", { content: "REGISTRY BODY", sha: "sha-1", etag: '"v1"' }],
      ]),
    );

    const first = await resolveRuleSourceDoc("prism", "standing-rules.md");
    const second = await resolveRuleSourceDoc("prism", "standing-rules.md");

    expect(first.notModified).toBe(false);
    expect(second.notModified).toBe(true);
    // The point of the whole exercise: identical content, WITHOUT a second body.
    expect(second.content).toBe(first.content);
    expect(second.sha).toBe("sha-1");
    expect(second.path).toBe(".prism/standing-rules.md");
    expect(requests).toHaveLength(2);
    expect(requests[0].ifNoneMatch).toBeNull();
    expect(requests[1].ifNoneMatch).toBe('"v1"');
  });

  it("serves NEW content when the document changed (200 wins over the cached copy)", async () => {
    const files = new Map([
      [".prism/standing-rules.md", { content: "OLD", sha: "sha-1", etag: '"v1"' }],
    ]);
    installFakeGitHub(files);

    const first = await resolveRuleSourceDoc("prism", "standing-rules.md");
    files.set(".prism/standing-rules.md", { content: "NEW", sha: "sha-2", etag: '"v2"' });
    const second = await resolveRuleSourceDoc("prism", "standing-rules.md");

    expect(first.content).toBe("OLD");
    expect(second.content).toBe("NEW");
    expect(second.sha).toBe("sha-2");
    expect(second.notModified).toBe(false);

    // And the refreshed ETag is what the THIRD read revalidates with.
    const third = await resolveRuleSourceDoc("prism", "standing-rules.md");
    expect(third.notModified).toBe(true);
    expect(third.content).toBe("NEW");
  });

  it("falls back to the legacy root path on a genuine 404 and caches THAT path", async () => {
    const requests = installFakeGitHub(
      new Map([["insights.md", { content: "LEGACY", sha: "sha-9", etag: '"L1"' }]]),
    );

    const first = await resolveRuleSourceDoc("legacy-repo", "insights.md");
    expect(first.path).toBe("insights.md");
    expect(first.legacy).toBe(true);
    expect(first.content).toBe("LEGACY");

    const second = await resolveRuleSourceDoc("legacy-repo", "insights.md");
    expect(second.legacy).toBe(true);
    expect(second.notModified).toBe(true);
    // Revalidation goes straight to the legacy path - the `.prism/` 404 probe
    // is not repeated.
    const last = requests[requests.length - 1];
    expect(last.url).toContain("/contents/insights.md");
    expect(last.ifNoneMatch).toBe('"L1"');
  });

  it("re-resolves from scratch when the cached path 404s (doc migrated)", async () => {
    const files = new Map([["insights.md", { content: "LEGACY", sha: "sha-9", etag: '"L1"' }]]);
    installFakeGitHub(files);

    const first = await resolveRuleSourceDoc("migrating-repo", "insights.md");
    expect(first.path).toBe("insights.md");

    // The doc moves to .prism/ between calls.
    files.delete("insights.md");
    files.set(".prism/insights.md", { content: "MIGRATED", sha: "sha-10", etag: '"M1"' });

    const second = await resolveRuleSourceDoc("migrating-repo", "insights.md");
    expect(second.path).toBe(".prism/insights.md");
    expect(second.legacy).toBe(false);
    expect(second.content).toBe("MIGRATED");
  });

  it("propagates an operational error on a cached path instead of silently re-resolving", async () => {
    installFakeGitHub(
      new Map([[".prism/insights.md", { content: "BODY", sha: "sha-1", etag: '"v1"' }]]),
    );
    await resolveRuleSourceDoc("prism", "insights.md");

    // A transient 401 must NOT look like "the file moved" (SRV-44).
    globalThis.fetch = vi.fn(async () =>
      new Response("bad credentials", { status: 401 }),
    ) as unknown as typeof fetch;

    await expect(resolveRuleSourceDoc("prism", "insights.md")).rejects.toThrow(/401/);
  });

  it("does not cache a document the server gave no ETag for", async () => {
    const requests = installFakeGitHub(
      new Map([[".prism/insights.md", { content: "BODY", sha: "sha-1", etag: null }]]),
    );

    await resolveRuleSourceDoc("no-etag-repo", "insights.md");
    const second = await resolveRuleSourceDoc("no-etag-repo", "insights.md");

    expect(second.notModified).toBe(false);
    expect(second.content).toBe("BODY");
    // Both reads were unconditional - nothing was ever served unvalidated.
    expect(requests.every((r) => r.ifNoneMatch === null)).toBe(true);
  });
});

describe("MCP-1 - sha-keyed standing-rule parse cache", () => {
  beforeEach(() => {
    clearStandingRulesParseCache();
  });

  it("returns the same union as the uncached function", () => {
    const registry = ruleDoc("INS-1", "Registry procedure.");
    const insights = "# Insights\n\n### INS-2: Legacy rule - STANDING RULE [TIER:B]\n\n**Standing procedure:** Legacy procedure.\n\n<!-- EOF: insights.md -->\n";

    const direct = unionStandingRules(registry, insights);
    const cached = unionStandingRulesCached(
      "prism",
      { content: registry, sha: "sr-1" },
      { content: insights, sha: "ins-1" },
    );

    expect(cached).toEqual(direct);
  });

  it("a changed sha yields a re-parse, never the previous answer", () => {
    const v1 = ruleDoc("INS-1", "First.");
    const v2 = ruleDoc("INS-1", "Second.");

    const first = unionStandingRulesCached(
      "prism",
      { content: v1, sha: "sr-1" },
      { content: null, sha: null },
    );
    const second = unionStandingRulesCached(
      "prism",
      { content: v2, sha: "sr-2" },
      { content: null, sha: null },
    );

    expect(first.rules[0].procedure).toBe("First.");
    expect(second.rules[0].procedure).toBe("Second.");
  });

  it("keys by repo, so two projects never share a parse", () => {
    const a = ruleDoc("INS-1", "Project A.");
    const b = ruleDoc("INS-1", "Project B.");

    const projectA = unionStandingRulesCached(
      "alpha",
      { content: a, sha: "same-sha" },
      { content: null, sha: null },
    );
    const projectB = unionStandingRulesCached(
      "beta",
      { content: b, sha: "same-sha" },
      { content: null, sha: null },
    );

    expect(projectA.rules[0].procedure).toBe("Project A.");
    expect(projectB.rules[0].procedure).toBe("Project B.");
  });

  it("hands out fresh arrays, so a caller cannot corrupt the cached entry", () => {
    const registry = ruleDoc("INS-1", "Procedure.");
    const first = unionStandingRulesCached(
      "prism",
      { content: registry, sha: "sr-1" },
      { content: null, sha: null },
    );
    first.rules.length = 0;

    const second = unionStandingRulesCached(
      "prism",
      { content: registry, sha: "sr-1" },
      { content: null, sha: null },
    );
    expect(second.rules).toHaveLength(1);
  });

  it("declines to cache when a present document has no known sha", () => {
    const v1 = ruleDoc("INS-1", "First.");
    const v2 = ruleDoc("INS-1", "Second.");

    const first = unionStandingRulesCached(
      "prism",
      { content: v1, sha: null },
      { content: null, sha: null },
    );
    const second = unionStandingRulesCached(
      "prism",
      { content: v2, sha: null },
      { content: null, sha: null },
    );

    // An unknown sha cannot key a cache honestly, so both calls really parse.
    expect(first.rules[0].procedure).toBe("First.");
    expect(second.rules[0].procedure).toBe("Second.");
  });
});

describe("MemoryCache size bound", () => {
  it("evicts the oldest entry once maxEntries is reached", () => {
    const cache = new MemoryCache<string>("test", 5, 2);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");

    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
  });

  it("re-setting an existing key refreshes its position instead of evicting", () => {
    const cache = new MemoryCache<string>("test", 5, 2);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("a", "1-updated");
    cache.set("c", "3");

    expect(cache.get("a")).toBe("1-updated");
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).toBe("3");
  });
});
