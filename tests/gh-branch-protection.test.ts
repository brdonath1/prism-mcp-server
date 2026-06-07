/**
 * gh_get_branch_protection / gh_set_branch_protection — unit tests for the
 * brief-446 tools and their client helpers.
 *
 * Per INS-31, HTTP-routing tests must mock global fetch and route by URL +
 * method. Client-level tests exercise getBranchProtection /
 * setBranchProtection directly; tool-level tests capture the registered
 * handler via a mock McpServer (same pattern as
 * bootstrap-recommendation.test.ts) and flow through the real client into
 * the mocked fetch.
 *
 * Behavior coverage (brief-446 V2):
 *   1. get returns the parsed protection JSON
 *   2. get on an unprotected branch returns { protected: false } (not a throw)
 *   3. get distinguishes "no protection rule" from a real 404 (missing branch)
 *   4. set normalizes the four required-or-null PUT keys (omitted →
 *      explicit null) and passes provided fields through unchanged
 *   5. set surfaces API errors via isError: true at the tool layer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBranchProtection, setBranchProtection } from "../src/github/client.js";
import { registerGhGetBranchProtection } from "../src/tools/gh-get-branch-protection.js";
import { registerGhSetBranchProtection } from "../src/tools/gh-set-branch-protection.js";

interface RecordedCall {
  url: string;
  method: string;
  body?: string;
}

type ToolResponse = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResponse>;

/** Register a gh_* tool against a mock server and capture its handler. */
function captureHandler(
  register: (server: McpServer) => void,
  toolName: string,
): ToolHandler {
  let captured: ToolHandler | null = null;
  const mockServer = {
    tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => {
      if (name === toolName) captured = handler as ToolHandler;
    }),
  } as unknown as McpServer;
  register(mockServer);
  if (!captured) throw new Error(`${toolName} handler was not registered`);
  return captured;
}

/** Sample protection JSON in the shape GitHub's GET/PUT responses use. */
const SAMPLE_PROTECTION = {
  url: "https://api.github.com/repos/o/test-repo/branches/main/protection",
  required_status_checks: { strict: true, contexts: ["ci"], checks: [{ context: "ci", app_id: null }] },
  enforce_admins: { enabled: true },
  required_linear_history: { enabled: false },
};

describe("brief-446 — branch protection client helpers + tools", () => {
  let originalFetch: typeof fetch;
  let calls: RecordedCall[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /** Install a fetch mock that records calls and replies via `respond`. */
  function mockFetch(respond: (url: string, method: string) => Response): void {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: init?.body as string | undefined });
      return respond(url, method);
    }) as unknown as typeof fetch;
  }

  describe("getBranchProtection", () => {
    it("200 → { success: true, protection: <parsed JSON> }", async () => {
      mockFetch((url, method) => {
        if (method === "GET" && url.endsWith("/branches/main/protection")) {
          return new Response(JSON.stringify(SAMPLE_PROTECTION), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(`Unexpected: ${method} ${url}`, { status: 500 });
      });

      const result = await getBranchProtection("test-repo", "main");

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.protection).toEqual(SAMPLE_PROTECTION);

      const getCall = calls.find((c) => c.method === "GET");
      expect(getCall).toBeDefined();
      expect(getCall!.url).toContain("/branches/main/protection");
    });

    it("404 'Branch not protected' → soft success with { protected: false } (not a throw)", async () => {
      mockFetch((url, method) => {
        if (method === "GET" && url.endsWith("/branches/main/protection")) {
          return new Response(
            JSON.stringify({ message: "Branch not protected" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(`Unexpected: ${method} ${url}`, { status: 500 });
      });

      const result = await getBranchProtection("test-repo", "main");

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.protection).toEqual({ protected: false });
    });

    it("404 'Branch not found' → { success: false, error } (missing branch is a real error)", async () => {
      mockFetch((url, method) => {
        if (method === "GET" && url.endsWith("/branches/nope/protection")) {
          return new Response(
            JSON.stringify({ message: "Branch not found" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(`Unexpected: ${method} ${url}`, { status: 500 });
      });

      const result = await getBranchProtection("test-repo", "nope");

      expect(result.success).toBe(false);
      expect(result.protection).toBeUndefined();
      expect(result.error).toContain("Not found");
    });

    it("encodes slash-containing branch names as a single path segment", async () => {
      mockFetch((url, method) => {
        if (method === "GET" && url.endsWith("/branches/feat%2Fx/protection")) {
          return new Response(JSON.stringify(SAMPLE_PROTECTION), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(`Unexpected: ${method} ${url}`, { status: 500 });
      });

      const result = await getBranchProtection("test-repo", "feat/x");

      expect(result.success).toBe(true);
      expect(calls[0].url).toContain("/branches/feat%2Fx/protection");
    });
  });

  describe("setBranchProtection", () => {
    it("normalizes the four required-or-null keys: omitted keys are sent as explicit null", async () => {
      mockFetch((url, method) => {
        if (method === "PUT" && url.endsWith("/branches/main/protection")) {
          return new Response(JSON.stringify(SAMPLE_PROTECTION), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(`Unexpected: ${method} ${url}`, { status: 500 });
      });

      // Caller supplies only enforce_admins + one boolean — the other three
      // required-or-null keys are absent and MUST be sent as explicit null
      // or GitHub 422s (the PUT quirk this brief exists to guard).
      const result = await setBranchProtection("test-repo", "main", {
        enforce_admins: true,
        required_linear_history: true,
      });

      expect(result.success).toBe(true);

      const putCall = calls.find((c) => c.method === "PUT");
      expect(putCall).toBeDefined();
      const sent = JSON.parse(putCall!.body!) as Record<string, unknown>;
      expect(sent.enforce_admins).toBe(true);
      expect(sent.required_linear_history).toBe(true);
      // All four required-or-null keys present; the three omitted are null.
      expect(Object.keys(sent)).toEqual(
        expect.arrayContaining([
          "required_status_checks",
          "enforce_admins",
          "required_pull_request_reviews",
          "restrictions",
        ]),
      );
      expect(sent.required_status_checks).toBeNull();
      expect(sent.required_pull_request_reviews).toBeNull();
      expect(sent.restrictions).toBeNull();
    });

    it("passes provided fields through unchanged (no nulling of supplied keys, undefined stripped)", async () => {
      mockFetch((url, method) => {
        if (method === "PUT" && url.endsWith("/branches/main/protection")) {
          return new Response(JSON.stringify(SAMPLE_PROTECTION), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(`Unexpected: ${method} ${url}`, { status: 500 });
      });

      const result = await setBranchProtection("test-repo", "main", {
        required_status_checks: { strict: true, checks: [{ context: "ci" }] },
        required_pull_request_reviews: { required_approving_review_count: 1 },
        allow_force_pushes: false,
        lock_branch: undefined, // undefined → stripped, not sent
      });

      expect(result.success).toBe(true);

      const sent = JSON.parse(calls.find((c) => c.method === "PUT")!.body!) as Record<string, unknown>;
      expect(sent.required_status_checks).toEqual({ strict: true, checks: [{ context: "ci" }] });
      expect(sent.required_pull_request_reviews).toEqual({ required_approving_review_count: 1 });
      expect(sent.allow_force_pushes).toBe(false);
      expect("lock_branch" in sent).toBe(false);
      // The two unsupplied required-or-null keys are still normalized.
      expect(sent.enforce_admins).toBeNull();
      expect(sent.restrictions).toBeNull();
    });

    it("non-2xx → { success: false, error } via handleApiError", async () => {
      mockFetch((url, method) => {
        if (method === "PUT" && url.endsWith("/branches/main/protection")) {
          return new Response(
            JSON.stringify({ message: "Validation Failed" }),
            { status: 422, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(`Unexpected: ${method} ${url}`, { status: 500 });
      });

      const result = await setBranchProtection("test-repo", "main", {});

      expect(result.success).toBe(false);
      expect(result.protection).toBeUndefined();
      expect(result.error).toContain("GitHub validation failed");
    });
  });

  describe("gh_get_branch_protection tool handler", () => {
    it("success → protection JSON in content, no isError", async () => {
      mockFetch((url, method) => {
        if (method === "GET" && url.endsWith("/branches/main/protection")) {
          return new Response(JSON.stringify(SAMPLE_PROTECTION), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(`Unexpected: ${method} ${url}`, { status: 500 });
      });

      const handler = captureHandler(registerGhGetBranchProtection, "gh_get_branch_protection");
      const result = await handler({ repo: "test-repo", branch: "main" });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.repo).toBe("test-repo");
      expect(parsed.branch).toBe("main");
      expect(parsed.protection).toEqual(SAMPLE_PROTECTION);
    });

    it("unprotected branch → { protected: false } in content, no isError", async () => {
      mockFetch((url, method) => {
        if (method === "GET" && url.endsWith("/branches/main/protection")) {
          return new Response(
            JSON.stringify({ message: "Branch not protected" }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(`Unexpected: ${method} ${url}`, { status: 500 });
      });

      const handler = captureHandler(registerGhGetBranchProtection, "gh_get_branch_protection");
      const result = await handler({ repo: "test-repo", branch: "main" });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.protection).toEqual({ protected: false });
    });
  });

  describe("gh_set_branch_protection tool handler", () => {
    it("success → resulting protection JSON in content, no isError", async () => {
      mockFetch((url, method) => {
        if (method === "PUT" && url.endsWith("/branches/main/protection")) {
          return new Response(JSON.stringify(SAMPLE_PROTECTION), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(`Unexpected: ${method} ${url}`, { status: 500 });
      });

      const handler = captureHandler(registerGhSetBranchProtection, "gh_set_branch_protection");
      const result = await handler({
        repo: "test-repo",
        branch: "main",
        protection: { enforce_admins: true },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.repo).toBe("test-repo");
      expect(parsed.protection).toEqual(SAMPLE_PROTECTION);
    });

    it("API error → isError: true with the error message in content", async () => {
      mockFetch((url, method) => {
        if (method === "PUT" && url.endsWith("/branches/main/protection")) {
          return new Response(
            JSON.stringify({ message: "Validation Failed" }),
            { status: 422, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(`Unexpected: ${method} ${url}`, { status: 500 });
      });

      const handler = captureHandler(registerGhSetBranchProtection, "gh_set_branch_protection");
      const result = await handler({
        repo: "test-repo",
        branch: "main",
        protection: {},
      });

      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain("GitHub validation failed");
      expect(parsed.repo).toBe("test-repo");
      expect(parsed.branch).toBe("main");
    });
  });
});
