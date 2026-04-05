# S30 Brief: prism_patch Integrity Fix

> **Target repo:** `prism-mcp-server`
> **Priority:** Critical — active bug causing file corruption across projects
> **Scope:** `src/tools/patch.ts` refactor, new utility module, comprehensive test suite
> **Estimated impact:** No tool surface changes (input/output schema unchanged) — INS-11 reconnect NOT required

---

## Pre-Flight

### 1. Sync
```bash
cd ~/repos/prism-mcp-server && git pull origin main
```

### 2. Verify current state
```bash
# Confirm patch.ts exists and has the buggy regex
grep -n 'sectionRegex' src/tools/patch.ts
# Confirm no existing tests for patch
ls tests/
# Confirm vitest is installed
npx vitest --version
```

### 3. Understand the bug
The `applyPatch` function in `src/tools/patch.ts` uses this regex to find markdown sections:

```typescript
const sectionRegex = new RegExp(
  `(${escapedHeader}[^\\\\n]*\\\\n)([\\\\s\\\\S]*?)(?=(?:^#{1,${headerLevel}} )|<!-- EOF:|$)`,
  "m"
);
```

**The bug:** The `m` (multiline) flag makes `$` match the end of *every line*, not just end of string. The lazy `[\s\S]*?` therefore stops at the end of the first body line (where `$` first matches). This means:

- **Replace** only replaces header + first body line; remaining old content persists as duplicates
- **Append** coincidentally works (appends after first line, which is "close enough" for single-entry sections)
- **Prepend** works correctly (inserts right after header regardless of body length)

The corruption is worst on `replace` of multi-line sections, which creates duplicate content that compounds with each subsequent patch attempt.

---

## Changes

### Phase 1: Extract markdown section utilities to a testable module

**Create `src/utils/markdown-sections.ts`**

This module extracts all markdown section logic from `patch.ts` into a standalone, fully testable utility. Three exported functions:

#### 1.1: `parseSections(content: string): Section[]`

A proper section parser that replaces the fragile single-regex approach. Algorithm:

1. Scan the content line by line (split on `\n`)
2. Identify header lines matching `/^(#{1,6})\s+(.+)$/`
3. For each header, record: `header` (full line), `level` (number of `#`), `startIndex` (byte offset in content), `headerEndIndex` (byte offset after header line + newline)
4. Compute section boundaries: each section's body extends from `headerEndIndex` to whichever comes first:
   - The `startIndex` of the next header at the **same or higher level** (fewer or equal `#`s)
   - A line starting with `<!-- EOF:` 
   - End of string
5. Return array of `Section` objects with: `header`, `level`, `body`, `startIndex`, `endIndex`

**Type definition:**
```typescript
export interface Section {
  header: string;       // Full header line (e.g., "## Voice Infrastructure")
  level: number;        // Header level (number of #s)
  body: string;         // Content between this header and next section boundary
  startIndex: number;   // Byte offset where header starts in the document
  endIndex: number;     // Byte offset where this section ends (exclusive)
}
```

**Critical edge cases to handle:**
- Content before the first header (preamble) — not a section, skip it
- Empty sections (header immediately followed by another header or EOF)
- Nested subsections: `### Sub` inside `## Parent` — `## Parent`'s body includes `### Sub` and its content (boundary is next `##` or higher, not `###`)
- Section at end of file with no trailing newline
- Section ending at `<!-- EOF:` sentinel (PRISM convention)
- Headers inside code blocks (``` fenced) — **must be ignored**. Scan for fenced code block boundaries and skip header detection inside them.
- Bold formatting in headers (e.g., `## **Section Name**`) — must still match when the `sectionHeader` input may or may not include the bold markers

#### 1.2: `applyPatch(content: string, sectionHeader: string, operation: "append" | "prepend" | "replace", patchContent: string): string`

Uses `parseSections()` to find the target section, then applies the operation:

- **Finding the target:** Match `sectionHeader` against each `section.header`. Use a normalized comparison:
  1. Exact match first (case-sensitive)
  2. If no exact match: strip bold markers (`**`), trim whitespace, compare case-insensitively
  3. If still no match: throw `Section not found: "{sectionHeader}"`
  4. If multiple matches found at the same level: throw `Ambiguous section: "{sectionHeader}" matches {N} sections — use a more specific header`

- **Applying the operation:**
  - `append`: Insert `patchContent` before the section's `endIndex`, after trimming trailing whitespace from the existing body. Result: `header + existingBody.trimEnd() + "\n" + patchContent + "\n\n"`
  - `prepend`: Insert `patchContent` immediately after the header line. Result: `header + "\n" + patchContent + "\n" + existingBody`
  - `replace`: Replace entire section body with new content. Result: `header + "\n" + patchContent + "\n\n"`. **The old body is completely removed.**

- **Reconstructing the document:** Use `content.substring(0, section.startIndex) + newSection + content.substring(section.endIndex)` — the `endIndex` from `parseSections` is now reliable because it's computed by walking headers, not by a regex lookahead.

#### 1.3: `validateIntegrity(content: string): IntegrityResult`

Post-patch safety check. Runs after all patches are applied, before pushing.

```typescript
export interface IntegrityIssue {
  type: "duplicate_header" | "empty_section" | "orphaned_content";
  header: string;
  details: string;
}

export interface IntegrityResult {
  valid: boolean;
  issues: IntegrityIssue[];
}
```

**Checks performed:**
1. **Duplicate headers at the same level:** Parse sections and check for any two sections with the exact same header text at the same nesting level. This catches the exact corruption pattern from the bug — where replace leaves old content that creates a duplicate section.
2. **Empty sections created by patch:** Warn (but don't block) if a patch created a section with a header but empty body. This is a smell that a replace may have gone wrong.

Return `{ valid: true, issues: [] }` if clean, or `{ valid: false, issues: [...] }` with diagnostics. The tool handler will use this to reject the push if `valid` is false.

**Important:** Only `duplicate_header` issues should set `valid: false`. Empty sections are warnings, not errors (some sections are legitimately empty).

### Phase 2: Refactor `src/tools/patch.ts`

Update `patch.ts` to import from the new utility module:

1. **Remove** the inline `applyPatch` function entirely
2. **Import** `applyPatch` and `validateIntegrity` from `../utils/markdown-sections.js`
3. **Add integrity validation** after the patch loop, before pushing:

```typescript
// After all patches applied successfully:
const integrity = validateIntegrity(content);
if (!integrity.valid) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: "Post-patch integrity check failed — file not modified",
        issues: integrity.issues,
        patches_attempted: results,
      }),
    }],
    isError: true,
  };
}
```

4. **Add integrity result to success response:**

```typescript
// In the success response, add:
integrity_check: integrity.issues.length > 0
  ? { warnings: integrity.issues }
  : { clean: true },
```

5. **Keep everything else unchanged:** The tool registration, parameter schema, commit message format, error handling for individual patch failures — all stay the same. The tool's external interface (input params and output shape) does not change in any breaking way; we're only adding optional fields to the response.

### Phase 3: Comprehensive test suite

**Create `tests/markdown-sections.test.ts`**

Tests import directly from `src/utils/markdown-sections.ts` (vitest + TypeScript, no build step needed for tests). All tests are pure functions — no mocking, no GitHub API calls, no network.

**Required test cases (minimum — add more if you identify edge cases during implementation):**

#### parseSections tests:

1. **Basic parsing** — Document with 3 `##` sections. Verify correct header, level, body, startIndex, endIndex for each.
2. **Nested sections** — `## Parent` with `### Child` subsection. Verify Parent's body includes Child. Verify Child's endIndex stops at next `##`.
3. **Mixed levels** — `#`, `##`, `###`, `##`, `#` — verify boundary detection respects level hierarchy.
4. **EOF sentinel** — Section ending at `<!-- EOF: file.md -->`. Verify endIndex stops before sentinel.
5. **Empty section** — `## Empty\n## Next` — verify empty body, correct boundaries.
6. **Last section (no trailing header)** — Single `## Section` followed by content and nothing else. Verify endIndex = content.length.
7. **Headers in code blocks** — A fenced code block containing `## Not A Header`. Verify it is NOT parsed as a section.
8. **Preamble content** — Content before the first header. Verify it's excluded from sections array.
9. **Header with bold formatting** — `## **Bold Header**` — verify it parses correctly.
10. **Header with trailing whitespace** — `## Section   \n` — verify clean parsing.

#### applyPatch tests:

11. **Replace single-line section** — Replace a section with 1 line of body. Verify old content gone, new content present.
12. **Replace multi-line section (THE BUG CASE)** — Replace a section with 5+ lines of body. Verify ALL old lines removed, new content present, no duplicates. This is the regression test.
13. **Replace section at end of file** — No following header. Verify complete replacement.
14. **Replace section before EOF sentinel** — Verify sentinel preserved, old content removed.
15. **Replace with nested subsections** — `## Parent` contains `### Child`. Replace Parent. Verify Child is also removed (replaced entirely).
16. **Append to section** — Verify new content appears after existing body, before next section.
17. **Append to empty section** — Verify new content appears correctly after header.
18. **Prepend to section** — Verify new content appears immediately after header, before existing body.
19. **Section not found** — Verify throws with clear error message.
20. **Ambiguous section (duplicate headers in input)** — Two `## Same Name` sections. Verify throws with ambiguity error.
21. **Header matching with bold markers** — Target `## Bold Section` but document has `## **Bold Section**`. Verify normalized match works.
22. **Sequential multi-patch** — Apply 3 patches to different sections in one document. Verify all apply correctly without interfering with each other. Critically: verify that after patch 1 changes the document, patches 2 and 3 operate on the UPDATED document (re-parse between patches).

#### validateIntegrity tests:

23. **Clean document** — No issues. Verify `valid: true, issues: []`.
24. **Duplicate headers** — Two `## Same` sections. Verify `valid: false` with `duplicate_header` issue.
25. **Duplicate headers at different levels** — `## Foo` and `### Foo`. Verify `valid: true` (different levels are OK).
26. **Empty section warning** — Verify empty section produces warning but `valid: true`.

#### Integration tests (applyPatch + validateIntegrity):

27. **The full corruption scenario** — Start with a realistic `architecture.md`-like document (15+ sections, nested subsections). Apply a replace patch to a multi-line section. Verify the result passes integrity validation. This is the end-to-end regression test.
28. **Multi-patch with integrity check** — Apply 3 patches, run integrity check. Verify clean result.

### Phase 4: Verify build and tests

After all changes:

```bash
# Run tests
npx vitest run

# Verify TypeScript compilation
npx tsc --noEmit

# Build
npm run build
```

All tests must pass. Zero TypeScript errors. Build must succeed.

---

## Verification

### Automated (must all pass)
```bash
# 1. Tests pass
npx vitest run

# 2. TypeScript compiles clean
npx tsc --noEmit

# 3. Build succeeds
npm run build

# 4. Verify the bug fix specifically — run this inline test
npx vitest run -t "multi-line"
```

### Manual spot-checks
```bash
# 5. Verify the old regex is GONE from patch.ts
grep -c 'sectionRegex' src/tools/patch.ts
# Expected: 0

# 6. Verify patch.ts imports from markdown-sections
grep 'markdown-sections' src/tools/patch.ts
# Expected: import line present

# 7. Verify integrity check is in patch.ts
grep 'validateIntegrity' src/tools/patch.ts
# Expected: at least 1 match

# 8. Verify new utility module exists
ls -la src/utils/markdown-sections.ts
# Expected: file exists

# 9. Verify test file exists and has all required test cases
grep -c 'test\|it(' tests/markdown-sections.test.ts
# Expected: >= 28 test cases
```

---

## Post-Flight

### 1. Push and deploy
```bash
git add -A
git commit -m "fix: prism_patch section parser rewrite with integrity validation (S30)"
git push origin main
```

Railway auto-deploys on push to `main`. Wait for deploy to complete.

### 2. No connector reconnect needed
This change does NOT modify the tool surface — input parameters and tool name are identical. The output JSON gains optional fields (`integrity_check`) but this is additive and non-breaking. Per INS-11, reconnect is only required for tool surface changes. **Do not reconnect the MCP connector.**

### 3. Sync
```bash
git pull origin main
```

---

## Summary of artifacts produced

| File | Action | Description |
|------|--------|-------------|
| `src/utils/markdown-sections.ts` | **CREATE** | Section parser, applyPatch, validateIntegrity |
| `src/tools/patch.ts` | **MODIFY** | Remove inline applyPatch, import from utility, add integrity check |
| `tests/markdown-sections.test.ts` | **CREATE** | 28+ test cases covering parser, patch, integrity, integration |

## Data source pinning (INS-13)

- `applyPatch` in `src/utils/markdown-sections.ts` consumes the `content: string` parameter directly. It does NOT read from GitHub — the tool handler in `patch.ts` is responsible for fetching file content via `fetchFile()` and passing it to `applyPatch()`.
- `parseSections` operates on the same `content` string. Section boundaries are computed by iterating lines, not by regex lookahead.
- `validateIntegrity` operates on the final patched `content` string (after all patches applied) — this is the same variable that `patch.ts` passes to `pushFile()`.
- The tool handler in `patch.ts` continues to use `fetchFile(project_slug, file)` for reads and `pushFile(project_slug, file, content, message)` for writes — these data flows are unchanged.

<!-- EOF: s30-patch-integrity-fix.md -->
