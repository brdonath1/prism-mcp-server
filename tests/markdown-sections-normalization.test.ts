/**
 * S42 regression test — applyPatch must normalize trailing newlines in
 * patchContent for replace and append, preventing blank-line drift at
 * section boundaries.
 *
 * Pre-S42 behavior: both `replace` and `append` unconditionally suffixed
 * the reconstructed section with `"\n\n"`. If the caller's content ended
 * with `\n` (the common case when content is built from multi-line string
 * literals), the resulting three consecutive newlines produced an extra
 * blank line at the section boundary — a cosmetic but accumulating drift
 * observed during S42's KI-16 live verification (round-trip replace
 * produced a 1-byte-larger file than the original).
 *
 * Post-S42 behavior: `stripTrailingNewlines` normalizes patchContent
 * before the `"\n\n"` suffix, so round-trip replace is byte-identical and
 * repeated replaces/appends do not accumulate blank lines.
 */

import { describe, it, expect } from "vitest";
import { applyPatch, parseSections } from "../src/utils/markdown-sections.js";

// ---------------------------------------------------------------------------
// Fixture — mimics the KI-16 verification file structure from S42
// ---------------------------------------------------------------------------

const FIXTURE = `# Known Issues -- PRISM

## Active

### KI-16: sample header
- **Severity:** HIGH
- **Discovered:** S28
- **Component:** patch action
- **Description:** original description line one. Second sentence.
- **Workaround:** original workaround text.
- **Status:** original status text

### KI-13: next header
- **Severity:** LOW
- **Status:** next-section body intact

<!-- EOF: known-issues.md -->
`;

const ORIGINAL_BODY = `- **Severity:** HIGH
- **Discovered:** S28
- **Component:** patch action
- **Description:** original description line one. Second sentence.
- **Workaround:** original workaround text.
- **Status:** original status text`;

const ORIGINAL_BODY_WITH_TRAILING_NL = ORIGINAL_BODY + "\n";

const TEST_BODY = `- **Severity:** HIGH
- **Discovered:** S28
- **Component:** patch action
- **Description:** MODIFIED description with multiple lines. Line two. Line three.
- **Workaround:** MODIFIED workaround text.
- **Status:** MODIFIED status text`;

const TEST_BODY_WITH_TRAILING_NL = TEST_BODY + "\n";

describe("S42 — applyPatch replace: trailing-newline normalization", () => {
  it("is byte-identical whether patchContent ends with \\n or not (replace)", () => {
    const noTrailing = applyPatch(
      FIXTURE,
      "### KI-16: sample header",
      "replace",
      TEST_BODY,
    );
    const withTrailing = applyPatch(
      FIXTURE,
      "### KI-16: sample header",
      "replace",
      TEST_BODY_WITH_TRAILING_NL,
    );

    expect(noTrailing).toBe(withTrailing);
  });

  it("round-trip replace with trailing-\\n content is byte-identical to original", () => {
    const afterFirst = applyPatch(
      FIXTURE,
      "### KI-16: sample header",
      "replace",
      TEST_BODY_WITH_TRAILING_NL,
    );
    const afterRoundTrip = applyPatch(
      afterFirst,
      "### KI-16: sample header",
      "replace",
      ORIGINAL_BODY_WITH_TRAILING_NL,
    );

    expect(afterRoundTrip).toBe(FIXTURE);
  });

  it("does not accumulate drift across repeated replaces", () => {
    let state = FIXTURE;
    for (let i = 0; i < 5; i++) {
      state = applyPatch(
        state,
        "### KI-16: sample header",
        "replace",
        ORIGINAL_BODY_WITH_TRAILING_NL,
      );
    }
    expect(state).toBe(FIXTURE);
  });

  it("preserves exactly one blank line between replaced section and next header", () => {
    const result = applyPatch(
      FIXTURE,
      "### KI-16: sample header",
      "replace",
      TEST_BODY_WITH_TRAILING_NL,
    );
    // MODIFIED status text + \n + blank line + \n + next header
    expect(result).toContain("MODIFIED status text\n\n### KI-13:");
    // Must NOT contain an extra blank line (three consecutive \n)
    expect(result).not.toContain("MODIFIED status text\n\n\n### KI-13:");
  });

  it("leaves adjacent sections structurally intact after replace", () => {
    const result = applyPatch(
      FIXTURE,
      "### KI-16: sample header",
      "replace",
      TEST_BODY_WITH_TRAILING_NL,
    );
    const sections = parseSections(result);
    const ki13 = sections.find((s) => s.header === "### KI-13: next header");
    expect(ki13).toBeDefined();
    expect(ki13!.body).toContain("next-section body intact");
    expect(ki13!.body).toContain("- **Severity:** LOW");
  });
});

describe("S42 — applyPatch append: trailing-newline normalization", () => {
  it("is byte-identical whether patchContent ends with \\n or not (append)", () => {
    const noTrailing = applyPatch(
      FIXTURE,
      "### KI-16: sample header",
      "append",
      "- **NewField:** appended value",
    );
    const withTrailing = applyPatch(
      FIXTURE,
      "### KI-16: sample header",
      "append",
      "- **NewField:** appended value\n",
    );

    expect(noTrailing).toBe(withTrailing);
  });

  it("does not accumulate drift across repeated appends of trailing-\\n content", () => {
    const first = applyPatch(
      FIXTURE,
      "### KI-16: sample header",
      "append",
      "- **NewField1:** value1\n",
    );
    const second = applyPatch(
      first,
      "### KI-16: sample header",
      "append",
      "- **NewField2:** value2\n",
    );
    // Exactly one blank line between section body and next header
    expect(second).toContain("- **NewField2:** value2\n\n### KI-13:");
    expect(second).not.toContain("- **NewField2:** value2\n\n\n### KI-13:");
  });
});

describe("S42 — applyPatch prepend: unchanged (not in scope for S42 fix)", () => {
  it("prepend semantics are NOT modified by the S42 normalization", () => {
    // Baseline: prepend puts patchContent before existing body separated by
    // a single \n. This test locks the current behavior so an accidental
    // "fix all three operations" refactor would be caught. If prepend
    // semantics change in a future session, update this test + its rationale.
    const result = applyPatch(
      FIXTURE,
      "### KI-16: sample header",
      "prepend",
      "- **Prepended:** line",
    );
    expect(result).toContain(
      "### KI-16: sample header\n- **Prepended:** line\n- **Severity:**",
    );
  });
});
