# Fix finalize banner resumption text — third path lookup missed by PR #22

**Repo:** `prism-mcp-server`
**File touched:** `src/tools/finalize.ts` (only)
**Discovered:** PRISM S76 (04-27-26)
**Type:** Path-only fix. Diagnosis settled, scope bounded — one `find()` call.

---

## Context

PR #22 (merged 02:13Z 04-27-26) fixed two of three handoff-related path lookups in the `prism_finalize` commit-phase banner-prep block: the handoff status badge and the decisions count. It missed the third — the resumption-text lookup that drives the "Resumption point" card body.

S75 was the first finalization on the post-PR-22 server (commit `a18291c0` at 03:44Z). The rendered banner shows the static fallback `See handoff.md for resumption point.` instead of the prior Where-We-Are first-paragraph narrative.

Verified empirically against this finalization:

- S75 finalize commit `a18291c0` modified exactly `.prism/handoff.md` (D-67 layout — `.prism/` prefix).
- The handoff under that path has both `## Where We Are` (multi-paragraph narrative) and `## Resumption Point` (S+1 ranked actions), so content is available for extraction.
- The current `files.find((f) => f.path === "handoff.md")` strict-equality lookup returns `undefined` for `.prism/handoff.md`, so `if (handoffFile) { ... }` never executes and `resumption` stays at its initialization fallback.

This is the same bug class that PR #22 closed for `result.results.find` (handoff status) and `files.find` against `decisions/_INDEX.md` (decisions count). All three were broken simultaneously by D-67; PR #22 fixed two; this brief fixes the third.

The boot banner is unaffected — it builds resumption text from a different code path (`resumption_point` field constructed in `bootstrap.ts`, not from a `files.find` against an in-flight commit array).

---

## Root cause

In `src/tools/finalize.ts`, inside the `try` block that builds `finalization_banner_html` (currently shortly after `const result = raced;` in the commit-phase handler):

```typescript
const handoffFile = files.find((f) => f.path === "handoff.md");
let resumption = "See handoff.md for resumption point.";
if (handoffFile) {
  const whereWeAre = extractSection(handoffFile.content, "Where We Are")
    ?? extractSection(handoffFile.content, "Current State")
    ?? "";
  if (whereWeAre.trim()) {
    const firstParagraph = whereWeAre.split("\n\n")[0]?.trim();
    if (firstParagraph) resumption = firstParagraph;
  }
}
```

Same path-mismatch class as PR #22 Bug 1. The operator-supplied `files[].path` is `.prism/handoff.md` for D-67-migrated projects, never bare `handoff.md`. PR #22 fixed the analogous `result.results.find` call in the handoff-status block but left this `files.find` untouched.

### Reading list

1. `src/tools/finalize.ts` — full file. The bug is in the `try { ... }` block beginning shortly after `const result = raced;` in the commit-phase branch of `registerFinalize`. The same block contains the two PR #22 fixes for context.
2. `briefs/fix-finalize-banner-paths.md` — predecessor brief for PR #22. Same shape, same import surface, same `DOC_ROOT` pattern. The pattern this brief uses is identical to that brief's Change 1.
3. `src/config.ts` — confirms `DOC_ROOT = ".prism"`. Already imported into `finalize.ts` (PR #22 introduced the import).

---

## Spec

One change in one block. `DOC_ROOT` is already imported at the top of the file (no new imports required).

### Change — handoff lookup for resumption-text extraction

Replace:
```typescript
const handoffFile = files.find((f) => f.path === "handoff.md");
```

With:
```typescript
const handoffFile = files.find(
  (f) => f.path === "handoff.md" || f.path === `${DOC_ROOT}/handoff.md`,
);
```

### Notes

- The variable name `whereWeAre` and the entire `if (handoffFile) { ... }` body are intentionally left alone. The section-extraction logic, the first-paragraph slice, and the fallback-string initialization are unchanged. This is a path-only fix.
- `project_slug` / `projectSlug` distinction does not apply here — this change is purely against the `files` array parameter, no helper calls introduced.

### Explicitly out of scope

- **Section-extraction strategy.** The card label rendered in the banner reads "Resumption point" but the extraction probes `## Where We Are` then `## Current State`. Probing `## Resumption Point` first would, on the current PRISM project's handoff, extract the lead-in line `S76 first-action ranking (operator priority overrides):` — uninformative without a multi-paragraph or structured-list rendering strategy. That is a separable design decision and warrants its own discussion; do not bundle it here.
- **First-paragraph slice semantics.** `split("\n\n")[0]` is the existing behavior; do not alter.
- **Banner card label/content alignment.** Out of scope.
- **Any other banner element** (handoff status, decisions count, deliverables, steps toolbar, warnings, errors).

---

## Verification

Runner MUST:

1. Apply the change exactly as specified.
2. **Build & typecheck.** Run the package's build command (likely `pnpm build`; confirm via `package.json` `scripts` field). Output reports 0 errors. Paste tail into PR body.
3. **Grep predicates.** Paste output into PR body under `## Verification greps`:
   - `grep -cF '(f) => f.path === "handoff.md")' src/tools/finalize.ts` → expected `0` (broken pattern removed)
   - `grep -cF '${DOC_ROOT}/handoff.md' src/tools/finalize.ts` → expected `2` (one occurrence introduced by PR #22 in the handoff-status `result.results.find`, one introduced by this fix in the `files.find`)
   - `grep -cF 'let resumption = "See handoff.md for resumption point."' src/tools/finalize.ts` → expected `1` (initialization unchanged)
   - `grep -cF 'extractSection(handoffFile.content, "Where We Are")' src/tools/finalize.ts` → expected `1` (extraction logic unchanged)
4. Paste the full updated `const handoffFile = ...` declaration through the closing `}` of the `if (handoffFile) { ... }` block into the PR body under `## Updated resumption-text block`.
5. `git status` shows ONLY `src/tools/finalize.ts` modified.

---

## Finishing up

- Open a PR against `main`.
  - **Title:** `fix: finalize banner resumption text path mismatch (third lookup, sibling of #22)`
  - **Body:** one-paragraph summary noting this is the third member of the PR #22 bug class (handoff status / decisions count / resumption text — all three broken by D-67, two fixed by #22), updated block, verification greps, build tail. Reference this brief: `briefs/fix-finalize-banner-resumption-text.md`.
- DO NOT deploy. Operator reviews, merges, and triggers Railway deploy manually.
- Exit without further commands after the PR is opened.
