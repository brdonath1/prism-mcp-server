// S63 Phase 1 Brief 2 — fetch.ts non-404 error classification
//
// Unit tests for the prism_fetch tool handler's error classification.
// Genuine 404s emit FILE_NOT_FOUND. Non-404 operational errors (5xx,
// timeout, rate limit, network) emit FILE_FETCH_ERROR with the error
// message in the diagnostic context, and the per-file response surfaces
// a `fetch_error` field so callers can distinguish "missing file" from
// "GitHub API is down."
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/github/client.js", () => ({
  fetchFile: vi.fn(),
}));

vi.mock("../src/utils/doc-resolver.js", () => ({
  resolveDocPath: vi.fn(),
}));

import { fetchFile } from "../src/github/client.js";
import { resolveDocPath } from "../src/utils/doc-resolver.js";

const mockFetchFile = vi.mocked(fetchFile);
const mockResolveDocPath = vi.mocked(resolveDocPath);

import { registerFetch } from "../src/tools/fetch.js";

interface ServerStubHandler {
  (input: Record<string, unknown>): Promise<{
    isError?: boolean;
    content: Array<{ type: "text"; text: string }>;
  }>;
}

function createServerStub() {
  const handlers: Record<string, ServerStubHandler> = {};
  const server = {
    tool(
      name: string,
      _description: string,
      _schema: unknown,
      handler: ServerStubHandler,
    ) {
      handlers[name] = handler;
    },
  };
  return { server, handlers };
}

interface FileResultPayload {
  path: string;
  exists: boolean;
  size_bytes: number;
  content: string | null;
  summary: string | null;
  is_summarized: boolean;
  fetch_error: string | null;
}

interface DiagnosticPayload {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
  context?: { path?: string; error?: string };
}

interface FetchResponsePayload {
  project: string;
  files: FileResultPayload[];
  bytes_delivered: number;
  files_fetched: number;
  diagnostics: DiagnosticPayload[];
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: arbitrary repo files bypass resolveDocPath. Tests that mix in
  // living-doc names override this.
  mockResolveDocPath.mockRejectedValue(new Error("should not be called"));
});

describe("prism_fetch error classification (S63 Phase 1 Brief 2)", () => {
  it("emits FILE_NOT_FOUND for a genuine 404, fetch_error stays null", async () => {
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path === "src/index.ts") {
        return { content: "export {};\n", sha: "ok-sha", size: 11 };
      }
      // The GitHub client wraps 404s with the literal "Not found:" prefix —
      // the inner catch in prism_fetch keys off that exact substring.
      throw new Error(`Not found: fetchFile test-project/${path}`);
    });

    const { server, handlers } = createServerStub();
    registerFetch(server as unknown as Parameters<typeof registerFetch>[0]);
    const handler = handlers.prism_fetch;
    expect(handler).toBeDefined();

    const result = await handler({
      project_slug: "test-project",
      files: ["src/missing.ts", "src/index.ts"],
      summary_mode: false,
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text) as FetchResponsePayload;

    const missing = payload.files.find((f) => f.path === "src/missing.ts");
    expect(missing).toBeDefined();
    expect(missing!.exists).toBe(false);
    expect(missing!.fetch_error).toBeNull();

    const found = payload.files.find((f) => f.path === "src/index.ts");
    expect(found!.exists).toBe(true);
    expect(found!.fetch_error).toBeNull();

    const codes = payload.diagnostics.map((d) => d.code);
    expect(codes).toContain("FILE_NOT_FOUND");
    expect(codes).not.toContain("FILE_FETCH_ERROR");

    const notFound = payload.diagnostics.find((d) => d.code === "FILE_NOT_FOUND");
    expect(notFound!.context!.path).toBe("src/missing.ts");
    expect(notFound!.level).toBe("warn");
  });

  it("emits FILE_FETCH_ERROR with the error message for a 5xx operational failure", async () => {
    mockFetchFile.mockImplementation(async () => {
      throw new Error("HTTP 503: Service Unavailable");
    });

    const { server, handlers } = createServerStub();
    registerFetch(server as unknown as Parameters<typeof registerFetch>[0]);
    const handler = handlers.prism_fetch;

    const result = await handler({
      project_slug: "test-project",
      files: ["src/api.ts"],
      summary_mode: false,
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text) as FetchResponsePayload;

    expect(payload.files).toHaveLength(1);
    const fileResult = payload.files[0];
    expect(fileResult.path).toBe("src/api.ts");
    expect(fileResult.exists).toBe(false);
    expect(fileResult.fetch_error).toBe("HTTP 503: Service Unavailable");

    const fetchErr = payload.diagnostics.find((d) => d.code === "FILE_FETCH_ERROR");
    expect(fetchErr).toBeDefined();
    expect(fetchErr!.level).toBe("warn");
    expect(fetchErr!.context!.path).toBe("src/api.ts");
    expect(fetchErr!.context!.error).toBe("HTTP 503: Service Unavailable");

    // Operational errors must NOT also be classified as FILE_NOT_FOUND.
    expect(payload.diagnostics.some((d) => d.code === "FILE_NOT_FOUND")).toBe(false);
  });

  it("mixed batch — one missing, one operational error, one success — classifies each correctly", async () => {
    mockFetchFile.mockImplementation(async (_repo: string, path: string) => {
      if (path === "src/missing.ts") {
        throw new Error("Not found: fetchFile test-project/src/missing.ts");
      }
      if (path === "src/api.ts") {
        throw new Error("HTTP 500: Internal Server Error");
      }
      if (path === "src/ok.ts") {
        return { content: "export const ok = 1;\n", sha: "ok-sha", size: 21 };
      }
      throw new Error(`Unexpected fetchFile path: ${path}`);
    });

    const { server, handlers } = createServerStub();
    registerFetch(server as unknown as Parameters<typeof registerFetch>[0]);
    const handler = handlers.prism_fetch;

    const result = await handler({
      project_slug: "test-project",
      files: ["src/missing.ts", "src/api.ts", "src/ok.ts"],
      summary_mode: false,
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text) as FetchResponsePayload;

    // Order preserved across the batch.
    expect(payload.files.map((f) => f.path)).toEqual([
      "src/missing.ts",
      "src/api.ts",
      "src/ok.ts",
    ]);

    // Genuine 404 — exists:false, fetch_error:null.
    expect(payload.files[0].exists).toBe(false);
    expect(payload.files[0].fetch_error).toBeNull();

    // Operational error — exists:false, fetch_error captures the message.
    expect(payload.files[1].exists).toBe(false);
    expect(payload.files[1].fetch_error).toBe("HTTP 500: Internal Server Error");

    // Success — content intact, fetch_error:null.
    expect(payload.files[2].exists).toBe(true);
    expect(payload.files[2].content).toBe("export const ok = 1;\n");
    expect(payload.files[2].fetch_error).toBeNull();

    // FILE_NOT_FOUND for the missing path only.
    const notFoundPaths = payload.diagnostics
      .filter((d) => d.code === "FILE_NOT_FOUND")
      .map((d) => d.context!.path);
    expect(notFoundPaths).toEqual(["src/missing.ts"]);

    // FILE_FETCH_ERROR for the operational error only, with the message
    // surfaced in the diagnostic context.
    const fetchErrors = payload.diagnostics.filter(
      (d) => d.code === "FILE_FETCH_ERROR",
    );
    expect(fetchErrors).toHaveLength(1);
    expect(fetchErrors[0].context!.path).toBe("src/api.ts");
    expect(fetchErrors[0].context!.error).toBe("HTTP 500: Internal Server Error");

    // No diagnostic for the successful file in either bucket.
    const allDiagPaths = payload.diagnostics
      .filter((d) => d.code === "FILE_NOT_FOUND" || d.code === "FILE_FETCH_ERROR")
      .map((d) => d.context!.path);
    expect(allDiagPaths).not.toContain("src/ok.ts");

    expect(payload.files_fetched).toBe(1);
  });
});
