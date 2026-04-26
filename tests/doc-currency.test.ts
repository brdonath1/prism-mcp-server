/**
 * Tests for the doc-currency parsing helpers (D-156 §3.7 / D-155).
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import {
  parseLastModifiedSession,
  parseArchDecisionsSinceSession,
  computeCurrencyWarning,
} from "../src/utils/doc-currency.js";

describe("parseLastModifiedSession", () => {
  it("parses a single `> Updated: S<N>` marker", () => {
    const body = `# Architecture

> Updated: S64

Body content here.`;
    expect(parseLastModifiedSession(body)).toBe(64);
  });

  it("returns null when the marker is absent", () => {
    const body = `# Architecture

No metadata, just narrative content.

## Section`;
    expect(parseLastModifiedSession(body)).toBeNull();
  });

  it("returns the highest session when multiple markers are present", () => {
    const body = `# Architecture

> Updated: S40

## Original section

Some content...

> Updated: S64

## Newer section`;
    expect(parseLastModifiedSession(body)).toBe(64);
  });

  it("returns null for malformed markers", () => {
    expect(parseLastModifiedSession("> Updated: SX")).toBeNull();
    expect(parseLastModifiedSession("> Updated: S")).toBeNull();
    expect(parseLastModifiedSession("> Updated: 64")).toBeNull();
    expect(parseLastModifiedSession("Updated: S64")).toBeNull(); // missing blockquote
  });
});

describe("parseArchDecisionsSinceSession", () => {
  const INDEX_BODY = `# Decisions

| ID | Title | Domain | Status | Session |
|----|-------|--------|--------|---------|
| D-100 | Earlier arch decision | architecture | SETTLED | 50 |
| D-101 | Recent arch decision | architecture | SETTLED | 60 |
| D-102 | Operations decision | operations | SETTLED | 65 |
| D-103 | Even newer arch decision | architecture | PENDING | 67 |`;

  it("counts architecture decisions strictly newer than the threshold", () => {
    const result = parseArchDecisionsSinceSession(INDEX_BODY, 55);
    expect(result.count).toBe(2);
    expect(result.ids).toEqual(["D-101", "D-103"]);
  });

  it("returns 0 when no architecture decisions are newer than the threshold", () => {
    const result = parseArchDecisionsSinceSession(INDEX_BODY, 100);
    expect(result.count).toBe(0);
    expect(result.ids).toEqual([]);
  });

  it("returns 0 when all architecture decisions are at-or-before the threshold (strictly greater)", () => {
    const result = parseArchDecisionsSinceSession(INDEX_BODY, 67);
    expect(result.count).toBe(0);
  });

  it("excludes non-architecture domain rows", () => {
    const result = parseArchDecisionsSinceSession(INDEX_BODY, 60);
    expect(result.count).toBe(1);
    expect(result.ids).toEqual(["D-103"]);
    // D-102 is operations — must not appear despite being newer.
  });

  it("returns 0 for an empty index body", () => {
    expect(parseArchDecisionsSinceSession("", 0)).toEqual({ count: 0, ids: [] });
  });
});

describe("computeCurrencyWarning", () => {
  it("computes all six fields for a stale architecture.md vs newer arch decisions", () => {
    const docBody = `# Architecture

> Updated: S40

Body.`;
    const indexBody = `| ID | Title | Domain | Status | Session |
|----|-------|--------|--------|---------|
| D-200 | Routing | architecture | SETTLED | 55 |
| D-201 | Caching | architecture | SETTLED | 60 |
| D-202 | Synthesis | architecture | SETTLED | 65 |`;

    const warning = computeCurrencyWarning({
      path: "architecture.md",
      docBody,
      indexBody,
      currentSession: 67,
    });

    expect(warning.path).toBe("architecture.md");
    expect(warning.last_modified_session).toBe(40);
    expect(warning.current_session).toBe(67);
    expect(warning.sessions_since_last_modified).toBe(27);
    expect(warning.pending_arch_decisions_count).toBe(3);
    expect(warning.pending_arch_decision_ids).toEqual(["D-200", "D-201", "D-202"]);
    expect(warning.acknowledgment_required).toBe(true);
  });

  it("does not require acknowledgment when sessions_since_last_modified <= 10", () => {
    const docBody = `> Updated: S64`;
    const indexBody = `| ID | Title | Domain | Status | Session |
|----|-------|--------|--------|---------|
| D-300 | Routing | architecture | SETTLED | 65 |`;

    const warning = computeCurrencyWarning({
      path: "architecture.md",
      docBody,
      indexBody,
      currentSession: 67,
    });

    expect(warning.sessions_since_last_modified).toBe(3);
    expect(warning.acknowledgment_required).toBe(false);
  });

  it("returns null fields and acknowledgment_required=false when the doc has no marker", () => {
    const indexBody = `| ID | Title | Domain | Status | Session |
|----|-------|--------|--------|---------|
| D-400 | Routing | architecture | SETTLED | 50 |`;

    const warning = computeCurrencyWarning({
      path: "glossary.md",
      docBody: "# Glossary\n\nNo metadata here.",
      indexBody,
      currentSession: 67,
    });

    expect(warning.last_modified_session).toBeNull();
    expect(warning.sessions_since_last_modified).toBeNull();
    expect(warning.acknowledgment_required).toBe(false);
  });
});
