// S47 P3.2 — filterLogs() must reclassify stdio-bridge INFO-as-error lines
// (A-10). Railway maps every stderr line to severity=error regardless of the
// application log level, which meant `@level:error` was swamped by benign
// github-mcp-server INFO messages.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import { filterLogs } from "../src/railway/client.js";

const t = "2026-04-18T12:00:00.000Z";

// Fixture: 5 log entries — 2 are stdio-bridge INFO-as-error, 2 are real
// errors, 1 is a normal info message.
const fixture = [
  {
    timestamp: t,
    severity: "error",
    message: 'time=2026-04-18T12:00:00.100Z level=INFO msg="server session connected"',
  },
  {
    timestamp: t,
    severity: "error",
    message: "TypeError: Cannot read properties of undefined (reading 'foo')",
  },
  {
    timestamp: t,
    severity: "error",
    message: 'time=2026-04-18T12:00:00.200Z level=INFO msg="starting github-mcp-server"',
  },
  {
    timestamp: t,
    severity: "info",
    message: "Express server listening on port 3000",
  },
  {
    timestamp: t,
    severity: "error",
    message: "GitHub API 500: internal server error (context createTree repo-x)",
  },
];

describe("S47 P3.2 — filterLogs reclassifies stdio-bridge INFO-as-error", () => {
  it("@level:error returns exactly the 2 real errors (not the INFO-as-error lines)", () => {
    const errors = filterLogs(fixture, "@level:error");
    expect(errors).toHaveLength(2);
    // Messages that pass through are the real ones.
    expect(errors[0].message).toContain("TypeError");
    expect(errors[1].message).toContain("GitHub API 500");
  });

  it("@level:info returns the normal info line PLUS the 2 reclassified stdio-bridge lines", () => {
    const infos = filterLogs(fixture, "@level:info");
    expect(infos).toHaveLength(3);
    const messages = infos.map((l) => l.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Express server listening"),
        expect.stringContaining("server session connected"),
        expect.stringContaining("starting github-mcp-server"),
      ]),
    );
  });

  it("reclassification does not mutate the caller's input array", () => {
    const snapshot = JSON.stringify(fixture);
    filterLogs(fixture, "@level:error");
    expect(JSON.stringify(fixture)).toBe(snapshot);
  });

  it("empty filter returns the full reclassified list (INFO-as-error already demoted)", () => {
    const all = filterLogs(fixture, undefined);
    // No filter — but reclassification still applies.
    expect(all).toHaveLength(5);
    const stillError = all.filter((l) => (l.severity ?? "").toLowerCase() === "error");
    expect(stillError).toHaveLength(2);
  });

  it("substring filter also sees reclassified severities (no regression)", () => {
    const bySubstring = filterLogs(fixture, "github-mcp-server");
    // Matches the "starting github-mcp-server" line which is now severity=info.
    expect(bySubstring).toHaveLength(1);
    expect(bySubstring[0].severity).toBe("info");
  });

  it("does NOT reclassify messages that do not match the stdio-bridge pattern", () => {
    const out = filterLogs(
      [
        {
          timestamp: t,
          severity: "error",
          message: "some other INFO message without the level=INFO prefix",
        },
      ],
      "@level:error",
    );
    // Still severity=error — pattern did not match, so no reclassification.
    expect(out).toHaveLength(1);
  });
});
