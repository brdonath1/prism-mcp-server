# Fix finalize banner path mismatches (handoff status + decisions count)

**Repo:** `prism-mcp-server`
**File touched:** `src/tools/finalize.ts` (only)
**Discovered:** PRISM S74 (04-26-26)
**Type:** Combined audit-and-fix. Diagnosis settled, scope bounded — both bugs in one banner-prep block.

---

## Context

The S73 finalization banner (rendered server-side in `prism_finalize` commit phase, returned via `finalization_banner_html`) displayed two incorrect statuses on a successful commit:

- **Handoff badge:** "v79 push failed" — but the push succeeded. S74 bootstrap confirmed handoff v79 is loadable and `boot_test_verified: true`.
- **Decisions card:** "0 (see index)" — but live `.prism/decisions/_INDEX.md` contains 113 decision rows.

Both are cosmetic — actual finalization succeeded — but they have been silently wrong for many sessions across all D-67-migrated PRISM projects (which is all of them today).

---

## Root cause (verified)

The banner rendering inside `registerFinalize` uses literal hardcoded paths that don't match the `.prism/`-prefixed paths produced by `guardPushPath`.

**Bug 1 — handoff status:**
```typescript
const handoffResult = result.results.find((r) => r.path === "handoff.md");
```
For D-67-migrated projects, `result.results[].path` is `.prism/handoff.md` (after `guardPushPath` redirect). `find()` returns `undefined`, then `!undefined?.success` evaluates `true`, triggering the "push failed" branch even when the push succeeded.

**Bug 2 — decisions count:**
```typescript
const indexFile = files.find((f) => f.path === "decisions/_INDEX.md");
```
Two compounding issues:
- Same path-mismatch class — would miss `.prism/decisions/_INDEX.md`.
- Per INS-178, `_INDEX.md` is structurally absent from the commit `files` array (it's atomically maintained via `prism_log_decision` during the session). So even after a path fix, the lookup against `files` would still fail for INS-178-disciplined projects. Need a different source of truth.

### Reading list (in order)

1. `src/tools/finalize.ts` — full file. The bugs are in the `try` block that builds `finalization_banner_html` inside the `registerFinalize` handler, after `const result = raced;` for the commit phase.
2. `src/config.ts` — confirms `DOC_ROOT = ".prism"` and `LIVING_DOCUMENTS` is the prefixed form.
3. `src/utils/doc-guard.ts` — confirms `guardPushPath` redirects root-level living-doc paths to `.prism/`-prefixed when the prefixed file exists.
4. `src/utils/doc-resolver.ts` — `resolveDocPath` signature (used in the Bug 2 fix). Already imported in `finalize.ts`.

---

## Spec

All changes confined to one `try` block in `src/tools/finalize.ts`. `DOC_ROOT` and `resolveDocPath` are already imported at the top of the file — no new imports required.

### Change 1 — Handoff status lookup

Replace:
```typescript
const handoffResult = result.results.find((r) => r.path === "handoff.md");
```

With:
```typescript
const handoffResult = result.results.find(
  (r) => r.path === "handoff.md" || r.path === `${DOC_ROOT}/handoff.md`,
);
```

### Change 2 — Decisions count source

Replace:
```typescript
let decisionsCount = 0;
const indexFile = files.find((f) => f.path === "decisions/_INDEX.md");
if (indexFile) {
  const rows = parseMarkdownTable(indexFile.content);
  decisionsCount = rows.length;
}
```

With:
```typescript
let decisionsCount = 0;
try {
  const indexDoc = await resolveDocPath(project_slug, "decisions/_INDEX.md");
  decisionsCount = parseMarkdownTable(indexDoc.content).length;
} catch {
  // Fall back to commit files array (handles legacy paths and unmigrated repos)
  const indexFile = files.find(
    (f) =>
      f.path === "decisions/_INDEX.md" ||
      f.path === `${DOC_ROOT}/decisions/_INDEX.md`,
  );
  if (indexFile) {
    decisionsCount = parseMarkdownTable(indexFile.content).length;
  }
}
```

### Notes

- `project_slug` is the handler-scope parameter (underscore form), NOT the helper's camelCase `projectSlug`. Use the local handler binding.
- Fetch happens AFTER `commitPhase` returns, so live `_INDEX.md` reflects any decisions logged this session via `prism_log_decision`. GitHub API consistency is sufficient — `safeMutation` awaits push completion.
- Fetch failure (network / missing file / unmigrated repo) falls back through the files-array path, then to 0. The outer `try/catch` around banner prep already nulls `finalization_banner_html` on hard error, so this is non-fatal regardless.

### Explicitly out of scope

The `livingDocPatterns` calculation for `docsUpdated` (a few lines above) mishandles `.prism/decisions/<domain>.md` paths — uses literal `"decisions/"` prefix that doesn't match `.prism/decisions/`. Tangential to the reported screenshot, separate fix.

---

## Verification

Runner MUST:

1. Apply both changes exactly as specified.
2. **Build & typecheck.** Run the package's build command (likely `pnpm build`; confirm via `package.json` `scripts` field). Output reports 0 errors. Paste tail into PR body.
3. **Grep predicates.** Paste output into PR body under `## Verification greps`:
   - `grep -cF '${DOC_ROOT}/handoff.md' src/tools/finalize.ts` → expected `1` (the new template-literal substring; baseline before fix was 0 occurrences of this exact string in the file)
   - `grep -cF 'await resolveDocPath(project_slug, "decisions/_INDEX.md")' src/tools/finalize.ts` → expected `1`
   - `grep -cF '(r) => r.path === "handoff.md")' src/tools/finalize.ts` → expected `0` (broken Bug 1 pattern removed)
   - `grep -cF '(f) => f.path === "decisions/_INDEX.md")' src/tools/finalize.ts` → expected `0` (broken Bug 2 pattern removed)
4. Paste the full updated `try { ... }` block (banner prep) into the PR body under `## Updated banner prep block`.
5. `git status` shows ONLY `src/tools/finalize.ts` modified.

---

## Finishing up

- Open a PR against `main`.
  - **Title:** `fix: finalize banner path mismatches (handoff status + decisions count)`
  - **Body:** one-paragraph summary, updated block, verification greps, build tail. Reference this brief: `briefs/fix-finalize-banner-paths.md`.
- DO NOT deploy. Operator reviews, merges, and triggers Railway deploy manually.
- Exit without further commands after the PR is opened.
