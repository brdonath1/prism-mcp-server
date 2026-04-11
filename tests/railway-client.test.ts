// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import {
  filterLogs,
  hasUrlCredentials,
  isSensitiveKey,
  isUuid,
  maskValue,
  maskVariables,
} from "../src/railway/client.js";
import type { RailwayLog, RailwayVariables } from "../src/railway/types.js";

describe("Railway client — pure helpers", () => {
  describe("isUuid", () => {
    it("accepts canonical UUID v4 format", () => {
      expect(isUuid("60692ab9-d35f-4115-a57e-750c8a99c948")).toBe(true);
      expect(isUuid("f34d918a-03ab-422f-a33a-98b9bd331b8a")).toBe(true);
    });

    it("accepts uppercase UUIDs", () => {
      expect(isUuid("60692AB9-D35F-4115-A57E-750C8A99C948")).toBe(true);
    });

    it("rejects non-UUID strings", () => {
      expect(isUuid("PlatformForge-v2")).toBe(false);
      expect(isUuid("production")).toBe(false);
      expect(isUuid("")).toBe(false);
      expect(isUuid("60692ab9-d35f-4115-a57e")).toBe(false); // truncated
      expect(isUuid("not-a-uuid")).toBe(false);
    });

    it("is whitespace-tolerant", () => {
      expect(isUuid("  60692ab9-d35f-4115-a57e-750c8a99c948  ")).toBe(true);
    });
  });

  describe("isSensitiveKey", () => {
    it("flags common secret patterns", () => {
      expect(isSensitiveKey("ANTHROPIC_API_KEY")).toBe(true);
      expect(isSensitiveKey("GITHUB_PAT")).toBe(false); // PAT is not in the list
      expect(isSensitiveKey("JWT_SECRET")).toBe(true);
      expect(isSensitiveKey("AUTH_TOKEN")).toBe(true);
      expect(isSensitiveKey("DB_PASSWORD")).toBe(true);
      expect(isSensitiveKey("PRIVATE_KEY")).toBe(true);
      expect(isSensitiveKey("SESSION_CREDENTIAL")).toBe(true);
    });

    it("does not flag innocuous keys", () => {
      expect(isSensitiveKey("NODE_ENV")).toBe(false);
      expect(isSensitiveKey("PORT")).toBe(false);
      expect(isSensitiveKey("LOG_LEVEL")).toBe(false);
      expect(isSensitiveKey("AI_MODEL")).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(isSensitiveKey("api_key")).toBe(true);
      expect(isSensitiveKey("api_Key")).toBe(true);
    });
  });

  describe("hasUrlCredentials", () => {
    it("detects postgres URLs with credentials", () => {
      expect(hasUrlCredentials("postgres://user:pass@host:5432/db")).toBe(true);
      expect(hasUrlCredentials("postgresql://u:p@host/db")).toBe(true);
    });

    it("detects https URLs with basic auth", () => {
      expect(hasUrlCredentials("https://user:password@example.com")).toBe(true);
    });

    it("does not flag URLs without embedded credentials", () => {
      expect(hasUrlCredentials("https://example.com")).toBe(false);
      expect(hasUrlCredentials("postgres://host:5432/db")).toBe(false);
    });

    it("does not flag plain strings", () => {
      expect(hasUrlCredentials("hello world")).toBe(false);
      expect(hasUrlCredentials("")).toBe(false);
    });
  });

  describe("maskValue", () => {
    it("keeps first 6 chars and appends ***", () => {
      expect(maskValue("abcdefghijklmnop")).toBe("abcdef***");
    });

    it("fully masks values shorter than prefix", () => {
      expect(maskValue("short")).toBe("***");
      expect(maskValue("abcdef")).toBe("***");
    });

    it("returns empty string for empty input", () => {
      expect(maskValue("")).toBe("");
    });

    it("respects custom prefix length", () => {
      expect(maskValue("abcdefghij", 3)).toBe("abc***");
    });
  });

  describe("maskVariables", () => {
    const sample: RailwayVariables = {
      NODE_ENV: "production",
      PORT: "3000",
      ANTHROPIC_API_KEY: "sk-ant-api03-super-secret-value",
      DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
      PUBLIC_URL: "https://example.com",
      AI_MODEL: "claude-opus-4-6",
    };

    it("masks everything when maskAll=true", () => {
      const out = maskVariables(sample, true);
      expect(out.NODE_ENV).toBe("produc***"); // "production" → first 6 + ***
      expect(out.PORT).toBe("***"); // "3000" is shorter than 6 → full mask
      expect(out.ANTHROPIC_API_KEY).toBe("sk-ant***");
      expect(out.DATABASE_URL).toBe("postgr***");
      expect(out.PUBLIC_URL).toBe("https:***");
      expect(out.AI_MODEL).toBe("claude***");
    });

    it("masks only sensitive keys when maskAll=false", () => {
      const out = maskVariables(sample, false);
      expect(out.NODE_ENV).toBe("production"); // safe
      expect(out.PORT).toBe("3000"); // safe
      expect(out.AI_MODEL).toBe("claude-opus-4-6"); // safe
      expect(out.PUBLIC_URL).toBe("https://example.com"); // no creds
      expect(out.ANTHROPIC_API_KEY).toBe("sk-ant***"); // sensitive key
      expect(out.DATABASE_URL).toBe("postgr***"); // URL with creds
    });

    it("returns an empty object for empty input", () => {
      expect(maskVariables({}, true)).toEqual({});
      expect(maskVariables({}, false)).toEqual({});
    });
  });

  describe("filterLogs", () => {
    const logs: RailwayLog[] = [
      { message: "Server started on port 3000", timestamp: "t1", severity: "info" },
      { message: "Failed to connect to database", timestamp: "t2", severity: "error" },
      { message: "Warning: high memory usage", timestamp: "t3", severity: "warn" },
      { message: "Request 200 OK /health", timestamp: "t4", severity: "info" },
      { message: "Error handling webhook", timestamp: "t5", severity: "error" },
    ];

    it("returns all logs when filter is undefined or empty", () => {
      expect(filterLogs(logs, undefined)).toHaveLength(5);
      expect(filterLogs(logs, "")).toHaveLength(5);
      expect(filterLogs(logs, "   ")).toHaveLength(5);
    });

    it("filters by @level:error", () => {
      const filtered = filterLogs(logs, "@level:error");
      expect(filtered).toHaveLength(2);
      expect(filtered.every((l) => l.severity === "error")).toBe(true);
    });

    it("filters by @level:info case-insensitively", () => {
      const filtered = filterLogs(logs, "@LEVEL:INFO");
      expect(filtered).toHaveLength(2);
      expect(filtered.every((l) => l.severity === "info")).toBe(true);
    });

    it("falls back to substring search on message", () => {
      const filtered = filterLogs(logs, "database");
      expect(filtered).toHaveLength(1);
      expect(filtered[0].message).toContain("database");
    });

    it("substring search is case-insensitive", () => {
      const filtered = filterLogs(logs, "WARNING");
      expect(filtered).toHaveLength(1);
    });

    it("returns empty array when nothing matches", () => {
      expect(filterLogs(logs, "nonexistent")).toEqual([]);
      expect(filterLogs(logs, "@level:fatal")).toEqual([]);
    });
  });
});

describe("Railway client — source-level contract", () => {
  const source = readFileSync("src/railway/client.ts", "utf-8");

  it("uses Bearer auth with RAILWAY_API_TOKEN", () => {
    expect(source).toContain("Bearer ${RAILWAY_API_TOKEN}");
  });

  it("posts to the Railway GraphQL endpoint from config", () => {
    expect(source).toContain("RAILWAY_API_ENDPOINT");
    expect(source).toContain("method: \"POST\"");
  });

  it("enforces an AbortSignal timeout under MCP_SAFE_TIMEOUT", () => {
    expect(source).toContain("AbortSignal.timeout");
    expect(source).toContain("MCP_SAFE_TIMEOUT");
  });

  it("surfaces 401/403 as auth failures", () => {
    expect(source).toMatch(/401.*403|401 \|\| res\.status === 403/s);
    expect(source).toContain("Railway authentication failed");
  });

  it("surfaces 429 as rate limit", () => {
    expect(source).toContain("429");
    expect(source).toContain("rate limit");
  });

  it("surfaces GraphQL errors to the caller", () => {
    expect(source).toContain("json.errors");
    expect(source).toContain("Railway GraphQL error");
  });

  it("refuses to run without a token", () => {
    expect(source).toContain("Railway API token is not configured");
  });

  it("implements all four variable operations", () => {
    expect(source).toContain("export async function listVariables");
    expect(source).toContain("export async function upsertVariable");
    expect(source).toContain("export async function deleteVariable");
    expect(source).toContain("variableUpsert");
    expect(source).toContain("variableDelete");
  });

  it("implements deployment management operations", () => {
    expect(source).toContain("export async function getLatestDeployment");
    expect(source).toContain("export async function listDeployments");
    expect(source).toContain("export async function redeployDeployment");
    expect(source).toContain("export async function restartDeployment");
    expect(source).toContain("deploymentRedeploy");
    expect(source).toContain("deploymentRestart");
  });

  it("implements log retrieval with inline Log fragment", () => {
    expect(source).toContain("export async function getDeploymentLogs");
    expect(source).toContain("export async function getEnvironmentLogs");
    expect(source).toContain("... on Log");
  });

  it("has a resolver class with project/service/environment resolution", () => {
    expect(source).toContain("export class RailwayResolver");
    expect(source).toContain("resolveProject");
    expect(source).toContain("resolveService");
    expect(source).toContain("resolveEnvironment");
  });
});

