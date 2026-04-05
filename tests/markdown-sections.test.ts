import { describe, it, expect } from "vitest";
import {
  parseSections,
  applyPatch,
  validateIntegrity,
} from "../src/utils/markdown-sections.js";

// ---------------------------------------------------------------------------
// parseSections tests
// ---------------------------------------------------------------------------

describe("parseSections", () => {
  it("1. Basic parsing — 3 ## sections", () => {
    const doc = [
      "## Section A",
      "Body A line 1",
      "Body A line 2",
      "",
      "## Section B",
      "Body B",
      "",
      "## Section C",
      "Body C",
      "",
    ].join("\n");

    const sections = parseSections(doc);
    expect(sections).toHaveLength(3);

    expect(sections[0].header).toBe("## Section A");
    expect(sections[0].level).toBe(2);
    expect(sections[0].body).toContain("Body A line 1");
    expect(sections[0].body).toContain("Body A line 2");

    expect(sections[1].header).toBe("## Section B");
    expect(sections[1].body).toContain("Body B");

    expect(sections[2].header).toBe("## Section C");
    expect(sections[2].body).toContain("Body C");

    // Verify boundaries don't overlap
    expect(sections[0].endIndex).toBe(sections[1].startIndex);
    expect(sections[1].endIndex).toBe(sections[2].startIndex);
  });

  it("2. Nested sections — ## Parent with ### Child", () => {
    const doc = [
      "## Parent",
      "Parent body",
      "### Child",
      "Child body",
      "## Next",
      "Next body",
    ].join("\n");

    const sections = parseSections(doc);

    // Parent's body should include Child subsection
    const parent = sections.find(s => s.header === "## Parent")!;
    expect(parent.body).toContain("### Child");
    expect(parent.body).toContain("Child body");
    expect(parent.endIndex).toBe(sections.find(s => s.header === "## Next")!.startIndex);

    // Child section exists separately
    const child = sections.find(s => s.header === "### Child")!;
    expect(child.level).toBe(3);
    expect(child.body).toContain("Child body");
    // Child endIndex stops at ## Next
    expect(child.endIndex).toBe(sections.find(s => s.header === "## Next")!.startIndex);
  });

  it("3. Mixed levels — #, ##, ###, ##, #", () => {
    const doc = [
      "# Top 1",
      "top body",
      "## Sub",
      "sub body",
      "### Deep",
      "deep body",
      "## Sub 2",
      "sub2 body",
      "# Top 2",
      "top2 body",
    ].join("\n");

    const sections = parseSections(doc);

    const top1 = sections.find(s => s.header === "# Top 1")!;
    const sub = sections.find(s => s.header === "## Sub")!;
    const deep = sections.find(s => s.header === "### Deep")!;
    const sub2 = sections.find(s => s.header === "## Sub 2")!;
    const top2 = sections.find(s => s.header === "# Top 2")!;

    // # Top 1 ends at # Top 2
    expect(top1.endIndex).toBe(top2.startIndex);
    // ## Sub ends at ## Sub 2
    expect(sub.endIndex).toBe(sub2.startIndex);
    // ### Deep ends at ## Sub 2 (higher level)
    expect(deep.endIndex).toBe(sub2.startIndex);
    // ## Sub 2 ends at # Top 2
    expect(sub2.endIndex).toBe(top2.startIndex);
  });

  it("4. EOF sentinel", () => {
    const doc = [
      "## Section",
      "Some content",
      "More content",
      "<!-- EOF: file.md -->",
    ].join("\n");

    const sections = parseSections(doc);
    expect(sections).toHaveLength(1);
    expect(sections[0].body).toContain("Some content");
    expect(sections[0].body).toContain("More content");
    expect(sections[0].body).not.toContain("<!-- EOF:");
  });

  it("5. Empty section", () => {
    const doc = [
      "## Empty",
      "## Next",
      "Next body",
    ].join("\n");

    const sections = parseSections(doc);
    const empty = sections.find(s => s.header === "## Empty")!;
    expect(empty.body).toBe("");
    expect(empty.endIndex).toBe(sections.find(s => s.header === "## Next")!.startIndex);
  });

  it("6. Last section — no trailing header", () => {
    const doc = [
      "## Only Section",
      "Line 1",
      "Line 2",
      "Line 3",
    ].join("\n");

    const sections = parseSections(doc);
    expect(sections).toHaveLength(1);
    expect(sections[0].endIndex).toBe(doc.length);
    expect(sections[0].body).toContain("Line 1");
    expect(sections[0].body).toContain("Line 3");
  });

  it("7. Headers in code blocks — must be ignored", () => {
    const doc = [
      "## Real Section",
      "Real body",
      "```",
      "## Not A Header",
      "fake body",
      "```",
      "Still real body",
      "## Next Real",
      "Next body",
    ].join("\n");

    const sections = parseSections(doc);
    const headers = sections.map(s => s.header);
    expect(headers).toContain("## Real Section");
    expect(headers).toContain("## Next Real");
    expect(headers).not.toContain("## Not A Header");

    // Real Section body should include the code block content
    const real = sections.find(s => s.header === "## Real Section")!;
    expect(real.body).toContain("## Not A Header");
    expect(real.body).toContain("Still real body");
  });

  it("8. Preamble content — excluded from sections", () => {
    const doc = [
      "This is preamble text.",
      "More preamble.",
      "",
      "## First Section",
      "Body",
    ].join("\n");

    const sections = parseSections(doc);
    expect(sections).toHaveLength(1);
    expect(sections[0].header).toBe("## First Section");
    // Preamble not in any section body
    for (const s of sections) {
      expect(s.body).not.toContain("preamble");
    }
  });

  it("9. Header with bold formatting", () => {
    const doc = [
      "## **Bold Header**",
      "Bold body",
    ].join("\n");

    const sections = parseSections(doc);
    expect(sections).toHaveLength(1);
    expect(sections[0].header).toBe("## **Bold Header**");
    expect(sections[0].body).toContain("Bold body");
  });

  it("10. Header with trailing whitespace", () => {
    const doc = "## Section   \nBody content\n";

    const sections = parseSections(doc);
    expect(sections).toHaveLength(1);
    expect(sections[0].header).toBe("## Section   ");
    expect(sections[0].body).toContain("Body content");
  });
});

// ---------------------------------------------------------------------------
// applyPatch tests
// ---------------------------------------------------------------------------

describe("applyPatch", () => {
  it("11. Replace single-line section", () => {
    const doc = [
      "## Section A",
      "Old content",
      "",
      "## Section B",
      "B body",
    ].join("\n");

    const result = applyPatch(doc, "## Section A", "replace", "New content");
    expect(result).toContain("## Section A");
    expect(result).toContain("New content");
    expect(result).not.toContain("Old content");
    expect(result).toContain("## Section B");
    expect(result).toContain("B body");
  });

  it("12. Replace multi-line section (THE BUG CASE)", () => {
    const doc = [
      "## Section A",
      "Old line 1",
      "Old line 2",
      "Old line 3",
      "Old line 4",
      "Old line 5",
      "",
      "## Section B",
      "B body",
    ].join("\n");

    const result = applyPatch(doc, "## Section A", "replace", "Replacement content");

    // ALL old lines must be gone
    expect(result).not.toContain("Old line 1");
    expect(result).not.toContain("Old line 2");
    expect(result).not.toContain("Old line 3");
    expect(result).not.toContain("Old line 4");
    expect(result).not.toContain("Old line 5");
    // New content present
    expect(result).toContain("Replacement content");
    // Section B preserved
    expect(result).toContain("## Section B");
    expect(result).toContain("B body");
    // No duplicate Section A headers
    expect(result.match(/## Section A/g)).toHaveLength(1);
  });

  it("13. Replace section at end of file", () => {
    const doc = [
      "## First",
      "First body",
      "",
      "## Last",
      "Old last body line 1",
      "Old last body line 2",
    ].join("\n");

    const result = applyPatch(doc, "## Last", "replace", "New last content");
    expect(result).not.toContain("Old last body");
    expect(result).toContain("New last content");
    expect(result).toContain("## First");
  });

  it("14. Replace section before EOF sentinel", () => {
    const doc = [
      "## Section",
      "Old body",
      "Old body line 2",
      "<!-- EOF: file.md -->",
    ].join("\n");

    const result = applyPatch(doc, "## Section", "replace", "New body");
    expect(result).not.toContain("Old body");
    expect(result).toContain("New body");
    expect(result).toContain("<!-- EOF: file.md -->");
  });

  it("15. Replace with nested subsections", () => {
    const doc = [
      "## Parent",
      "Parent body",
      "### Child",
      "Child body",
      "### Child 2",
      "Child 2 body",
      "## Next",
      "Next body",
    ].join("\n");

    const result = applyPatch(doc, "## Parent", "replace", "Completely new parent content");

    // Everything under Parent (including children) should be gone
    expect(result).not.toContain("Parent body");
    expect(result).not.toContain("### Child");
    expect(result).not.toContain("Child body");
    expect(result).not.toContain("Child 2 body");
    expect(result).toContain("Completely new parent content");
    expect(result).toContain("## Next");
    expect(result).toContain("Next body");
  });

  it("16. Append to section", () => {
    const doc = [
      "## Section A",
      "Existing line 1",
      "Existing line 2",
      "",
      "## Section B",
      "B body",
    ].join("\n");

    const result = applyPatch(doc, "## Section A", "append", "Appended content");
    expect(result).toContain("Existing line 1");
    expect(result).toContain("Existing line 2");
    expect(result).toContain("Appended content");
    // Appended content comes after existing body
    const existingIdx = result.indexOf("Existing line 2");
    const appendIdx = result.indexOf("Appended content");
    expect(appendIdx).toBeGreaterThan(existingIdx);
    // Section B still present
    expect(result).toContain("## Section B");
  });

  it("17. Append to empty section", () => {
    const doc = [
      "## Empty",
      "## Next",
      "Next body",
    ].join("\n");

    const result = applyPatch(doc, "## Empty", "append", "New content");
    expect(result).toContain("## Empty");
    expect(result).toContain("New content");
    expect(result).toContain("## Next");
  });

  it("18. Prepend to section", () => {
    const doc = [
      "## Section",
      "Existing body",
      "",
      "## Next",
      "Next body",
    ].join("\n");

    const result = applyPatch(doc, "## Section", "prepend", "Prepended content");
    expect(result).toContain("Prepended content");
    expect(result).toContain("Existing body");
    // Prepended content comes before existing body
    const prependIdx = result.indexOf("Prepended content");
    const existingIdx = result.indexOf("Existing body");
    expect(prependIdx).toBeLessThan(existingIdx);
  });

  it("19. Section not found — throws clear error", () => {
    const doc = "## Existing\nBody\n";

    expect(() =>
      applyPatch(doc, "## Nonexistent", "replace", "Content")
    ).toThrow('Section not found: "## Nonexistent"');
  });

  it("20. Ambiguous section — duplicate headers", () => {
    const doc = [
      "## Same Name",
      "Body 1",
      "## Same Name",
      "Body 2",
    ].join("\n");

    expect(() =>
      applyPatch(doc, "## Same Name", "replace", "New content")
    ).toThrow(/Ambiguous section.*matches 2 sections/);
  });

  it("21. Header matching with bold markers", () => {
    const doc = [
      "## **Bold Section**",
      "Bold body content",
      "",
      "## Normal Section",
      "Normal body",
    ].join("\n");

    // Target without bold markers should match via normalization
    const result = applyPatch(doc, "## Bold Section", "replace", "New bold content");
    expect(result).toContain("New bold content");
    expect(result).not.toContain("Bold body content");
  });

  it("22. Sequential multi-patch — 3 patches to different sections", () => {
    let doc = [
      "## Section A",
      "A original",
      "",
      "## Section B",
      "B original",
      "",
      "## Section C",
      "C original",
      "",
    ].join("\n");

    // Patch 1: replace A
    doc = applyPatch(doc, "## Section A", "replace", "A replaced");
    // Patch 2: append to B
    doc = applyPatch(doc, "## Section B", "append", "B appended");
    // Patch 3: prepend to C
    doc = applyPatch(doc, "## Section C", "prepend", "C prepended");

    // Verify all patches applied correctly
    expect(doc).toContain("A replaced");
    expect(doc).not.toContain("A original");
    expect(doc).toContain("B original");
    expect(doc).toContain("B appended");
    expect(doc).toContain("C prepended");
    expect(doc).toContain("C original");

    // Verify structure integrity — each section header appears exactly once
    expect(doc.match(/## Section A/g)).toHaveLength(1);
    expect(doc.match(/## Section B/g)).toHaveLength(1);
    expect(doc.match(/## Section C/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// validateIntegrity tests
// ---------------------------------------------------------------------------

describe("validateIntegrity", () => {
  it("23. Clean document — no issues", () => {
    const doc = [
      "## Section A",
      "Body A",
      "",
      "## Section B",
      "Body B",
      "",
    ].join("\n");

    const result = validateIntegrity(doc);
    expect(result.valid).toBe(true);
    expect(result.issues.filter(i => i.type === "duplicate_header")).toHaveLength(0);
  });

  it("24. Duplicate headers — invalid", () => {
    const doc = [
      "## Same",
      "Body 1",
      "",
      "## Same",
      "Body 2",
    ].join("\n");

    const result = validateIntegrity(doc);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.type === "duplicate_header")).toBe(true);
  });

  it("25. Duplicate headers at different levels — valid", () => {
    const doc = [
      "## Foo",
      "Body",
      "### Foo",
      "Sub body",
    ].join("\n");

    const result = validateIntegrity(doc);
    expect(result.valid).toBe(true);
    expect(result.issues.filter(i => i.type === "duplicate_header")).toHaveLength(0);
  });

  it("26. Empty section warning — valid with warning", () => {
    const doc = [
      "## Empty",
      "## Next",
      "Body",
    ].join("\n");

    const result = validateIntegrity(doc);
    expect(result.valid).toBe(true);
    expect(result.issues.some(i => i.type === "empty_section")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests (applyPatch + validateIntegrity)
// ---------------------------------------------------------------------------

describe("Integration", () => {
  it("27. Full corruption scenario — realistic architecture.md replacement", () => {
    const doc = [
      "# Architecture",
      "",
      "## Overview",
      "This is the project overview.",
      "It spans multiple lines.",
      "And has detailed architecture notes.",
      "",
      "### Components",
      "Component A: handles authentication",
      "Component B: handles data storage",
      "Component C: handles API gateway",
      "",
      "### Data Flow",
      "1. Request enters API gateway",
      "2. Auth middleware validates token",
      "3. Request routed to service",
      "4. Response cached and returned",
      "",
      "## Infrastructure",
      "Cloud provider: AWS",
      "Region: us-east-1",
      "Deployed via Terraform",
      "",
      "### Networking",
      "VPC with private subnets",
      "NAT gateway for outbound",
      "",
      "### Storage",
      "S3 for static assets",
      "RDS PostgreSQL for primary data",
      "Redis for caching",
      "",
      "## Security",
      "JWT-based authentication",
      "Role-based access control",
      "API rate limiting enabled",
      "",
      "## Monitoring",
      "Datadog for metrics",
      "PagerDuty for alerts",
      "CloudWatch for logs",
      "",
      "## Voice Infrastructure",
      "Twilio for voice calls",
      "WebSocket for real-time",
      "Media server: Janus",
      "",
      "### Call Routing",
      "SIP trunking via Twilio",
      "Failover to backup provider",
      "",
      "### Recording",
      "All calls recorded to S3",
      "Transcription via Whisper",
      "",
      "## Deployment",
      "CI/CD via GitHub Actions",
      "Blue/green deployments",
      "Rollback within 5 minutes",
      "",
      "## Dependencies",
      "Express 5.x",
      "TypeScript 5.x",
      "Node.js 18+",
      "PostgreSQL 15",
      "",
      "<!-- EOF: architecture.md -->",
    ].join("\n");

    // Replace the multi-line "Voice Infrastructure" section (this is the bug scenario)
    const result = applyPatch(
      doc,
      "## Voice Infrastructure",
      "replace",
      "LiveKit for voice/video\nSignalWire for PSTN\nCustom media server"
    );

    // Verify old content completely gone
    expect(result).not.toContain("Twilio for voice calls");
    expect(result).not.toContain("WebSocket for real-time");
    expect(result).not.toContain("Media server: Janus");
    // Nested subsections also removed
    expect(result).not.toContain("### Call Routing");
    expect(result).not.toContain("SIP trunking");
    expect(result).not.toContain("### Recording");
    expect(result).not.toContain("Transcription via Whisper");
    // New content present
    expect(result).toContain("LiveKit for voice/video");
    expect(result).toContain("SignalWire for PSTN");
    // Surrounding sections preserved
    expect(result).toContain("## Monitoring");
    expect(result).toContain("## Deployment");
    expect(result).toContain("## Dependencies");
    expect(result).toContain("<!-- EOF: architecture.md -->");
    // No duplicate headers
    expect(result.match(/## Voice Infrastructure/g)).toHaveLength(1);

    // Integrity check passes
    const integrity = validateIntegrity(result);
    expect(integrity.valid).toBe(true);
    expect(integrity.issues.filter(i => i.type === "duplicate_header")).toHaveLength(0);
  });

  it("28. Multi-patch with integrity check", () => {
    let doc = [
      "## Status",
      "Active",
      "",
      "## Tasks",
      "- Task 1",
      "- Task 2",
      "",
      "## Notes",
      "Some notes here",
      "",
    ].join("\n");

    // Apply 3 patches
    doc = applyPatch(doc, "## Status", "replace", "Completed");
    doc = applyPatch(doc, "## Tasks", "append", "- Task 3");
    doc = applyPatch(doc, "## Notes", "prepend", "Important: read this first");

    // All patches applied
    expect(doc).toContain("Completed");
    expect(doc).not.toContain("Active");
    expect(doc).toContain("- Task 3");
    expect(doc).toContain("Important: read this first");
    expect(doc).toContain("Some notes here");

    // Integrity check passes
    const integrity = validateIntegrity(doc);
    expect(integrity.valid).toBe(true);
    expect(integrity.issues.filter(i => i.type === "duplicate_header")).toHaveLength(0);
  });
});
