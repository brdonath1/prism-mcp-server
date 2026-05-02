# Brief 421 — KI-26: Neutralize embedded markdown headers in user-supplied content fields

**Repo:** prism-mcp-server  
**Addresses:** KI-26 (S85) — prism_log_decision / prism_patch content fields recreate file-corruption pattern  
**Branch:** main  
**PR title:** fix: KI-26 — neutralize embedded markdown headers in content/reasoning fields

---

## Problem

`prism_log_decision` and `prism_patch` write user-supplied strings directly into markdown files with zero sanitization. If any of the following fields contain a line starting with `## ` or `### `, that line becomes a real section header on subsequent parses, breaking the section tree and enabling silent corruption:

- `log-decision.ts`: `reasoning`, `assumptions`, `impact`, `title`
- `patch.ts` / `applyPatch()` in `markdown-sections.ts`: `content` (all three operations — append, prepend, replace)

`validateIntegrity()` only catches duplicate headers; a novel injected header (e.g. `## Injected Section`) passes cleanly.

---

## Fix Strategy

**Primary:** Sanitize at write-time by inserting a Unicode zero-width space (U+200B, `\u200B`) after the leading `#` characters on any line that begins with one or more `#` followed by a space, within all user-supplied content fields. This makes the line unrecognizable as a markdown header to the section parser while remaining readable to humans.

**Supplementary:** Extend `validateIntegrity()` to detect novel (non-pre-existing) section headers introduced by a patch or decision write, and surface them as a warning diagnostic. This is defense-in-depth — it does not replace write-time sanitization.

**Rationale for zero-width space over alternatives:**
- Blockquote prefix (`>`) changes the visual meaning of the content.
- 4-space indent makes it a code block, distorting prose reasoning.
- Hard rejection breaks legitimate use cases (Claude frequently includes headers in reasoning text).
- Zero-width space is invisible in rendered markdown, non-destructive, and parse-safe.

---

## Scope

Exactly **three files change**:

1. `src/utils/sanitize-content.ts` — new utility (new file)
2. `src/tools/log-decision.ts` — apply sanitization to `reasoning`, `assumptions`, `impact`, `title`
3. `src/tools/patch.ts` — apply sanitization to `content` before passing to `applyPatch()`

Optional supplementary (include if it fits within scope):
4. `src/utils/markdown-sections.ts` — extend `validateIntegrity()` to emit a `NOVEL_HEADER_INJECTED` warning when a header present post-patch was not present pre-patch

---

## Change 1 — `src/utils/sanitize-content.ts` (new file)

Create a new utility with a single exported function:

```ts
/**
 * Neutralize embedded markdown section headers in user-supplied content.
 *
 * Inserts a Unicode zero-width space (U+200B) after the leading '#' characters
 * on any line that begins with one or more '#' followed by a space. This makes
 * the line unrecognizable as a section header to the markdown parser while
 * remaining readable to humans in rendered output.
 *
 * Applies to all user-supplied content fields before they are written into
 * living documents: reasoning, assumptions, impact (log-decision.ts) and
 * content (patch.ts). Fixes KI-26.
 */
export function sanitizeContentField(text: string): string {
  // Match lines starting with 1+ '#' chars followed by a space, at any
  // position in the string (after \n or at string start).
  return text.replace(/((?:^|\n)(#{1,6}) )/g, '$2\u200B ');
}
```

The regex matches `#`, `##`, `###`, etc. followed by a space, at line starts. The zero-width space is inserted between the `#` cluster and the space, so `## Foo` becomes `##\u200B Foo`.

---

## Change 2 — `src/tools/log-decision.ts`

Import `sanitizeContentField` from the new utility. Apply it to all four user-supplied fields before interpolation:

```ts
import { sanitizeContentField } from "../utils/sanitize-content.js";

// Inside the handler, before building entryLines:
const safeReasoning = sanitizeContentField(reasoning);
const safeAssumptions = assumptions ? sanitizeContentField(assumptions) : undefined;
const safeImpact = impact ? sanitizeContentField(impact) : undefined;
const safeTitle = sanitizeContentField(title);

// Then use safe* vars in entryLines instead of raw vars.
// Note: safeTitle is used in the `### D-X: title` header line —
// if title itself contained a `## `, the zero-width space prevents
// the outer `### ` from being misread, though the title content
// would look odd. That's acceptable — callers should not put `## `
// in a decision title.
```

---

## Change 3 — `src/tools/patch.ts`

Import `sanitizeContentField` and apply it to `patch.content` before passing to `applyPatch()`:

```ts
import { sanitizeContentField } from "../utils/sanitize-content.js";

// In the patch loop, before calling applyPatch:
const safeContent = sanitizeContentField(patch.content);
content = applyPatch(content, patch.section, patch.operation, safeContent);
```

---

## Change 4 (supplementary) — `src/utils/markdown-sections.ts`

In `validateIntegrity()`, add a `NOVEL_HEADER_INJECTED` warning check. This requires the function to accept an optional `prePatchHeaders: string[]` parameter. When provided, any header present in the post-patch parse that was not in `prePatchHeaders` is flagged.

If this adds meaningful complexity, **skip it** — the primary fix (Changes 1–3) fully closes KI-26. The supplementary check is defense-in-depth, not required.

---

## Verification Steps (post-edit, pre-PR)

1. `npx tsc --noEmit` — zero errors.
2. `npx vitest run` (or `npm test`) — full suite passes.
3. Spot-check: in a test or REPL, `sanitizeContentField("intro\n## Header\nbody")` must return `"intro\n##\u200B Header\nbody"`.
4. Grep confirm: `grep -n 'sanitizeContentField' src/tools/log-decision.ts src/tools/patch.ts` — must appear in both files.

---

## Tests

Create `src/utils/__tests__/sanitize-content.test.ts` with at minimum:

1. Content with no headers → returned unchanged.
2. Content with `## Section` at line start → `## ` becomes `##\u200B `.
3. Content with `### Subsection` mid-string (after newline) → neutralized.
4. Content with `#` not followed by space (e.g. `#hashtag`) → NOT neutralized.
5. Content with fenced code block containing `## header` → still neutralized (acceptable; the zero-width space inside a code fence is harmless).
6. Empty string → returned unchanged.

Additionally, add integration-style tests to the existing `log-decision` and `patch` test files confirming that a `reasoning` / `content` value containing `## Injected` does NOT produce a real `## Injected` section header in the output document.

---

## Files Changed

- `src/utils/sanitize-content.ts` (new file)
- `src/utils/__tests__/sanitize-content.test.ts` (new file)
- `src/tools/log-decision.ts` (import + 4 sanitized vars)
- `src/tools/patch.ts` (import + 1 sanitized var)
- `src/utils/markdown-sections.ts` (optional supplementary — skip if complex)

<!-- EOF: brief-421-ki26-header-injection-sanitization.md -->
