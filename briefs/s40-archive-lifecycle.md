# S40 Brief — Archive Lifecycle for Living Documents (FINDING-14)

**Session:** PRISM S40 (04-17-26)
**Type:** IMPLEMENTATION (pushes to main)
**Scope:** Implement size-triggered archive lifecycle for `session-log.md` and `insights.md`. Archives are excluded from synthesis input. Long-term fix for synthesis cost growth.
**Dependency:** Run AFTER `briefs/s40-hang-elimination.md` has shipped and deployed. Do NOT run simultaneously — both briefs touch `src/tools/finalize.ts` and will conflict.
**Background reading (required):** `reports/s39-observability-perf-audit.md` — FINDING-14 section.

---

## Context

`insights.md` and `session-log.md` grow unbounded. As of S40: insights.md is 24.9KB (22 active entries), session-log.md is 14.5KB (40 sessions). Synthesis cost scales with input size — FINDING-14 identified this as the lever for long-term synthesis scaling.

Archive paths are already reserved in `src/utils/doc-guard.ts` for `session-log-archive.md`, `known-issues-archive.md`, and `build-history-archive.md`. No writers exist. **`insights-archive.md` is not yet reserved** — this brief adds it.

This brief implements the archive writers, integrates them into `prism_finalize` commit phase, excludes archives from synthesis inputs, and updates `prism_status` to surface archive state.

---

## Policy (Package B — Moderate, operator-confirmed S40)

| Doc              | Trigger threshold | Live retention            | Archive protection rule                                |
|------------------|-------------------|---------------------------|--------------------------------------------------------|
| `session-log.md` | > 15 KB           | 20 most recent sessions   | None — all old sessions archivable                    |
| `insights.md`    | > 20 KB           | 15 most recent insights   | `**STANDING RULE**`-tagged entries NEVER archived      |

Cross-cutting rules:
- **Decisions are never archived.** Decisions use their own domain-split system (`.prism/decisions/`), already immune to growth issues.
- **Archives are excluded from synthesis input.** Verified no path in `src/ai/synthesize.ts` or `src/tools/finalize.ts` draft phase reads archive files; this brief adds explicit exclusion as a belt-and-suspenders check.
- **Archives grow unbounded.** Out of scope for this brief. Flag as follow-up if archive files themselves exceed 100KB.
- **Archive writes happen in `commitPhase` only**, before the atomic commit, so archive + live doc land in a single commit (atomicity).
- **STANDING RULE protection is identity-based, not position-based.** Any insight tagged `**STANDING RULE**` (with the exact bold-asterisks markup) stays in live `insights.md` regardless of age or count.

---

## Verified living document structure

**session-log.md:**
- Header: `# Session Log -- PRISM Framework`
- Sessions in **reverse chronological** order (newest first)
- Marker regex: `^### Session (\d+)` — matches `### Session 39 (04-17-26 09:26:45 CST)`, `### Session 0 -- Pre-PRISM (2026-02-15)`, etc.
- No leading `##` top-level sections between the header and session entries — it's a flat list.

**insights.md:**
- Header: `# Insights — PRISM Framework`
- Two top-level sections: `## Active` and `## Formalized`
- Insight marker regex: `^### INS-(\d+):` — matches `### INS-6: ZodDefault breaks MCP SDK tool registration — STANDING RULE`
- STANDING RULE detection: title line contains ` STANDING RULE` (with leading space) OR body contains the literal string `**STANDING RULE**`. Use both checks — older entries used the title suffix, newer entries may use body-bold.
- **Archive operates on `## Active` section only.** Do NOT move entries from `## Formalized` (they're retrospective markers, small, and historically significant).

These are the verified structures as of S40 bootstrap. If CC finds drift (e.g. a session marker uses `## Session` instead of `### Session`), STOP and report rather than guess.

---

## Scope (4 changes, independently committed)

1. **Change 1:** New module `src/utils/archive.ts` with pure-function archive logic. Parses, splits, emits live + archive content. Full unit test coverage. No side effects.
2. **Change 2:** Integrate archive writes into `src/tools/finalize.ts` `commitPhase`. Runs before atomic commit so archive + live doc commit together.
3. **Change 3:** Add `insights-archive.md` to `KNOWN_PRISM_PATHS` in `src/utils/doc-guard.ts`. Add explicit archive-exclusion comment to `SYNTHESIS_DOCS` or equivalent list in `src/tools/finalize.ts` draft phase.
4. **Change 4:** Extend `prism_status` to surface archive file presence and size.

Execute in order. Each change has its own commit; shared final push.

---

## Pre-Flight

1. Verify `briefs/s40-hang-elimination.md` has shipped: `git log --oneline origin/main | head -10` should show the 4 S40-C1 through S40-C4 commits. If NOT present, STOP — this brief requires those changes.
2. Clean working tree on `main`: `git status` empty.
3. `npm ci` → clean install.
4. `npm test` → baseline pass; record exact count. Must be ≥ baseline after all changes.
5. `npm run build` → TypeScript clean.
6. Read `reports/s39-observability-perf-audit.md` FINDING-14 section for the original analysis.

If any pre-flight step fails, STOP and report. Do not proceed.

---

## Change 1 — Pure archive logic in src/utils/archive.ts

**Goal:** Isolate the parsing/splitting logic in a pure module. No I/O, no side effects, 100% unit-testable.

**New file:** `src/utils/archive.ts`

**Exported types:**
```ts
export interface ArchiveResult {
  /** Content to push as the live doc. Same header + most recent N entries. */
  liveContent: string;
  /** Content to push/append as the archive doc. Null if no archiving occurred. */
  archiveContent: string | null;
  /** Number of entries moved to archive. Zero when under threshold. */
  archivedCount: number;
  /** Human-readable reason for skip decisions (under threshold, no candidates, parse failure). */
  skipReason?: string;
}

export interface ArchiveConfig {
  /** Size threshold in bytes. Archiving only runs when input exceeds this. */
  thresholdBytes: number;
  /** How many most-recent entries to keep in the live doc. */
  retentionCount: number;
  /** Regex that identifies entry start lines. MUST have a capturing group for the entry number. */
  entryMarker: RegExp;
  /** Optional: entries whose title or body contains any of these strings are NEVER archived. */
  protectedMarkers?: string[];
  /** Header text for the archive file (shown at top). */
  archiveHeader: string;
  /** Optional: for docs with multiple top-level sections, only archive entries under this one (e.g., '## Active'). */
  activeSection?: string;
}
```

**Exported functions:**
```ts
/**
 * Split a living doc into (liveContent, archiveContent) based on config.
 * Pure function — no I/O.
 *
 * Returns { archiveContent: null, archivedCount: 0, skipReason: "..." } when
 * archiving does not occur (under threshold, no candidates after protection
 * filter, parse error).
 */
export function splitForArchive(
  input: string,
  existingArchive: string | null,
  config: ArchiveConfig
): ArchiveResult;

/**
 * Parse entries from a doc using the given marker regex. Returns entries in
 * document order (as they appear, not sorted by number).
 *
 * An "entry" is: the marker line + all subsequent lines until the next marker
 * line OR a top-level section heading (`^## `) OR end of file.
 */
export function parseEntries(
  input: string,
  marker: RegExp,
  activeSection?: string
): Array<{ number: number; title: string; body: string; isProtected: boolean; fullText: string }>;
```

**Algorithm for `splitForArchive`:**

1. If `input.length <= config.thresholdBytes`, return `{ liveContent: input, archiveContent: null, archivedCount: 0, skipReason: "under threshold" }`.
2. Parse entries via `parseEntries(input, config.entryMarker, config.activeSection)`.
3. If `entries.length <= config.retentionCount`, return skip (`"fewer entries than retention count"`).
4. Mark each entry's `isProtected` flag: true if its title OR body contains ANY string in `config.protectedMarkers`.
5. Determine which entries are eligible for archive: NOT protected AND positioned before the last `retentionCount` non-protected entries.
   - Example: if `retentionCount=15`, 22 total entries, 11 protected: eligible = (22 - 11) - 15 = −4, nothing to archive. Return skip (`"all candidates are protected or within retention"`).
   - Example: if `retentionCount=20`, 40 total entries, 0 protected: eligible = 40 - 20 = 20 oldest entries.
6. If no eligible entries, return skip.
7. Build new `liveContent`: everything in `input` EXCEPT the eligible entries. Preserve header, `## Active`/`## Formalized` section headers, and protected entries.
8. Build new `archiveContent`: start from `existingArchive` (or `config.archiveHeader` if null), append the eligible entries' `fullText` in the same order they appeared in the live doc.
9. Return `{ liveContent, archiveContent, archivedCount: eligible.length }`.

**Critical correctness details:**
- **"Most recent" depends on doc order.** `session-log.md` is reverse-chronological (newest FIRST). `insights.md` is chronological (INS-1 first, INS-22 last). The retention rule is "most recent N entries" — which is position-dependent. The config needs a `mostRecentAt: "top" | "bottom"` field, OR the caller pre-reverses. Pick whichever is cleaner; document the choice.
- **STANDING RULE detection for insights:** check the entry's title line for literal `STANDING RULE` (substring match, case-sensitive — the live doc uses `— STANDING RULE` consistently). Also check body for `**STANDING RULE**`. If either matches, `isProtected = true`.
- **Protected entries keep their original position in `liveContent`.** Do not reorder.
- **Archive file format for insights:** the archive output should be wrapped under `## Archived` (so the file has a predictable top-level section). Use the `archiveHeader` field to preserve this.

**Unit tests (add `test/archive.test.ts` or equivalent):**

1. Under threshold → no change, `skipReason` populated.
2. Over threshold, no protected entries, chronological order → oldest N − retention archived.
3. Over threshold, some protected entries → only non-protected oldest archived; protected keep position.
4. Over threshold, ALL entries protected → skip with reason.
5. Parse failure (malformed markers) → throw, do NOT silently proceed with wrong split.
6. Existing archive is null → new archive includes header + entries.
7. Existing archive has content → new archive appends without duplicating header.
8. Edge case: exactly at threshold → no archive (strict `>`).
9. Edge case: single protected entry at oldest position → stays in live, next entry archived instead.
10. Round-trip: concatenating (liveContent + archiveContent entries) reconstructs the original entry set (no data loss).

**Commit after Change 1:**
```
git add -A && git commit -m "feat(archive): add pure-function archive logic for living docs (S40 FINDING-14 C1)"
```

---

## Change 2 — Integrate archiving into finalize.ts commitPhase

**Goal:** Apply archive logic to `session-log.md` and `insights.md` before the atomic commit, so live + archive changes land atomically in one commit.

**Changes in `src/tools/finalize.ts`:**

1. Add imports:
   ```ts
   import { splitForArchive, type ArchiveConfig } from "../utils/archive.js";
   ```
2. Define archive configs near the top of the file (or in `src/config.ts` if you prefer — operator's choice, but keep colocated if new):
   ```ts
   const SESSION_LOG_ARCHIVE_CONFIG: ArchiveConfig = {
     thresholdBytes: 15_000,
     retentionCount: 20,
     entryMarker: /^### Session (\d+)/m,
     archiveHeader: "# Session Log Archive — PRISM Framework\n\n> Archived sessions moved here during finalization when session-log.md exceeds 15KB.\n> Archives are NEVER read by synthesis.\n",
     // session-log.md is reverse-chronological: newest at top
     // (plumb this into splitForArchive via mostRecentAt: 'top')
   };
   const INSIGHTS_ARCHIVE_CONFIG: ArchiveConfig = {
     thresholdBytes: 20_000,
     retentionCount: 15,
     entryMarker: /^### INS-(\d+):/m,
     protectedMarkers: ["STANDING RULE"],
     activeSection: "## Active",
     archiveHeader: "# Insights Archive — PRISM Framework\n\n> Archived insights moved here during finalization when insights.md exceeds 20KB.\n> Only non-STANDING-RULE insights are archived.\n> Archives are NEVER read by synthesis.\n\n## Archived\n",
     // insights.md is chronological: newest at bottom
   };
   ```
3. In `commitPhase`, AFTER validation and BEFORE the `createAtomicCommit` call, insert archive processing:
   ```ts
   // Archive processing — runs before atomic commit so live + archive land together
   async function applyArchive(
     liveFileName: string,
     archiveFileName: string,
     config: ArchiveConfig,
   ): Promise<void> {
     const liveIdx = files.findIndex(f => f.path === liveFileName || f.path === `${DOC_ROOT}/${liveFileName}`);
     if (liveIdx === -1) return; // Not being written this session — nothing to do

     // Fetch existing archive (may not exist yet)
     let existingArchive: string | null = null;
     try {
       const archivePath = `${DOC_ROOT}/${archiveFileName}`;
       const fetched = await fetchFile(projectSlug, archivePath);
       existingArchive = fetched.content;
     } catch {
       existingArchive = null; // First-time archive
     }

     const result = splitForArchive(files[liveIdx].content, existingArchive, config);

     if (result.archiveContent !== null && result.archivedCount > 0) {
       // Update live file in-place
       files[liveIdx] = { ...files[liveIdx], content: result.liveContent };
       // Add archive file to the commit
       files.push({
         path: `${DOC_ROOT}/${archiveFileName}`,
         content: result.archiveContent,
       });
       logger.info("archive applied", {
         projectSlug,
         live: liveFileName,
         archive: archiveFileName,
         archivedCount: result.archivedCount,
         liveSizeBytes: result.liveContent.length,
       });
     } else if (result.skipReason) {
       logger.debug("archive skipped", { projectSlug, live: liveFileName, reason: result.skipReason });
     }
   }

   await applyArchive("session-log.md", "session-log-archive.md", SESSION_LOG_ARCHIVE_CONFIG);
   await applyArchive("insights.md", "insights-archive.md", INSIGHTS_ARCHIVE_CONFIG);
   ```
4. Fail-open semantics: if archive processing throws (parse failure, bad regex, etc.), **log an error and continue without archiving for that doc**. Do NOT fail the finalize — a finalize that commits the live docs without archiving is still a success. Archiving is an optimization, not a requirement.

**Test additions:**

- Integration test: commitPhase with an over-threshold session-log in `files[]`, mock fetchFile for existing archive (null), assert resulting files[] has both updated live and new archive entries.
- Integration test: commitPhase with under-threshold session-log, assert files[] unchanged.
- Integration test: archive throws (mock splitForArchive), assert finalize still commits live docs.

**Commit after Change 2:**
```
git add -A && git commit -m "feat(finalize): apply archive lifecycle before atomic commit (S40 FINDING-14 C2)"
```

---

## Change 3 — doc-guard and synthesis exclusion

**Changes in `src/utils/doc-guard.ts`:**

1. Add `"insights-archive.md"` to the `KNOWN_PRISM_PATHS` array. Place near the existing archive entries:
   ```ts
   // Archive files
   "session-log-archive.md",
   "known-issues-archive.md",
   "build-history-archive.md",
   "insights-archive.md",  // <-- ADD THIS
   ```

**Changes in `src/tools/finalize.ts` (draft phase):**

1. Find `DRAFT_RELEVANT_DOCS` (currently filters out `architecture.md`, `glossary.md`, `intelligence-brief.md`).
2. Archive files are already not in `LEGACY_LIVING_DOCUMENTS`, so they're not pulled by synthesis today. Add a **defensive assertion and comment** to prevent future regression:
   ```ts
   const ARCHIVE_FILE_SUFFIX = "-archive.md";
   const DRAFT_RELEVANT_DOCS = LEGACY_LIVING_DOCUMENTS.filter(
     d => d !== "architecture.md"
       && d !== "glossary.md"
       && d !== "intelligence-brief.md"
       && !d.endsWith(ARCHIVE_FILE_SUFFIX)  // <-- ADD: belt-and-suspenders exclusion for archives
   );
   // Invariant: archives MUST NOT be synthesis input. They are cold storage.
   // If you find yourself adding archive files to this list, reconsider —
   // synthesis cost scales with input size (FINDING-14).
   ```

**Changes in `src/ai/synthesize.ts`** (if it independently lists docs to read):

1. Audit the file for any hard-coded doc paths or glob patterns that could pull archives. If found, add the same archive exclusion. If not found (all doc loading goes through `DRAFT_RELEVANT_DOCS` or similar), no change needed — document the invariant in a comment.

**Test additions:**

- Test that `DRAFT_RELEVANT_DOCS` never contains a string ending in `-archive.md`, even after future additions.
- Test that `doc-guard` correctly routes `insights-archive.md` to `.prism/insights-archive.md`.

**Commit after Change 3:**
```
git add -A && git commit -m "chore(archive): reserve insights-archive.md path, enforce synthesis exclusion (S40 FINDING-14 C3)"
```

---

## Change 4 — prism_status reports archive state

**Goal:** Operator visibility. `prism_status` should show whether archive files exist and their size, so it's clear when archiving has kicked in.

**Changes in `src/tools/status.ts`** (or wherever the status tool handler lives — search for `prism_status` tool registration):

1. Add archive file paths to the existence check. Files to check: `session-log-archive.md`, `insights-archive.md`, `known-issues-archive.md`, `build-history-archive.md`. All four — even the ones this brief doesn't implement writers for — because operators may add writers later.
2. Add to response payload:
   ```ts
   archives: {
     "session-log-archive.md": { exists: boolean, sizeBytes: number | null },
     "insights-archive.md": { exists: boolean, sizeBytes: number | null },
     "known-issues-archive.md": { exists: boolean, sizeBytes: number | null },
     "build-history-archive.md": { exists: boolean, sizeBytes: number | null },
   }
   ```
3. Use `Promise.allSettled` for the four existence checks so one failure doesn't break the whole status call.
4. If `include_details: true`, also include in the human-readable output a line like:
   ```
   Archives: session-log-archive.md (N KB), insights-archive.md (not yet created)
   ```

**Test additions:**

- Status call on a project with no archives → all four entries show `exists: false`.
- Status call on a project with `session-log-archive.md` → only that entry shows `exists: true, sizeBytes: N`.

**Commit after Change 4:**
```
git add -A && git commit -m "feat(status): report archive file presence and size (S40 FINDING-14 C4)"
```

---

## Verification (after all four changes committed)

1. `npm test` → all tests pass, count ≥ baseline plus the new archive tests. Expect roughly +15-25 new tests across the four changes.
2. `npm run build` → TypeScript clean.
3. `git log --oneline -6` → shows 4 new commits on top of the S40 hang-elimination commits.
4. Lint if repo has `npm run lint`.

---

## Finishing Up — SINGLE CHAINED COMMAND (per INS-20)

After all four commits and local verification:

```
npm test && npm run build && git push origin main && git log --oneline -10 origin/main
```

Do NOT stop short. Do NOT replace `&&` with `;`. If `npm test` or `npm run build` fails: STOP, report, do NOT push. Use `git reset --hard origin/main` to roll back if the changes are fundamentally broken.

---

## Post-Deploy Operator Action

1. Wait for Railway auto-deploy.
2. Reconnect PRISMv2 MCP Server connector in Claude.ai Settings (INS-11).
3. Start a NEW conversation (INS-10).
4. Validation test in new session — finalize PRISM itself:
   - Pre-check: PRISM's `insights.md` is 24.9KB > 20KB threshold. Next finalize should trigger insights archiving.
   - Pre-check: PRISM's `session-log.md` is 14.5KB < 15KB threshold. Will NOT trigger this session; will on a subsequent one.
   - After finalize: call `prism_status project_slug: "prism" include_details: true` — verify `insights-archive.md` exists with N bytes.
   - Verify `insights.md` live size dropped to ~under 20KB, has ≤15 active entries (11 STANDING RULE + up to 4 most recent non-STANDING-RULE). Formalized section unchanged.
   - Verify `insights-archive.md` contains the non-STANDING-RULE old entries (INS-1, 2, 3, 5, 9, 12, 14 — the 7 oldest non-protected).
5. Smoke test: bootstrap a new session, confirm standing rules still loaded (all STANDING RULE entries still resolvable from live `insights.md`).
6. If validation passes, FINDING-14 is closed. Other projects' archives trigger automatically when they hit thresholds.

**Rollback plan if validation reveals a bug:** `insights.md` and `insights-archive.md` are both committed atomically. To roll back, revert the commit; live + archive both revert together. No data loss possible because archive logic is additive (moves content, never deletes from commit history — earlier git revisions retain the pre-archive state).

<!-- EOF: s40-archive-lifecycle.md -->
