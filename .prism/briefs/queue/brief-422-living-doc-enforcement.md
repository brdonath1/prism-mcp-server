# Brief 422 — Living Document Enforcement: PDU Auto-Apply, Architecture Timestamps, Task-Queue Cap

**Repo:** prism-mcp-server  
**Session:** S117  
**Priority:** High  
**Scope:** Four coordinated enhancements to eliminate recurring manual maintenance work  
**Version bump:** v4.6.0 → v4.7.0

---

## Context

Every PRISM session accumulates a small but persistent maintenance overhead: applying pending-doc-updates proposals, updating architecture.md timestamps, and pruning the task-queue Recently Completed section. These are not judgment calls — they are mechanical, repetitive, and fully specifiable. Yet there is currently no auto-apply path anywhere in the server. The PDU synthesis generates proposals that sit in a file until an operator explicitly works through them session by session, competing with real work.

Audit findings (S117 cc_dispatch query, dispatch cc-1777700119352-e682f9bb):
- `finalize.ts` post-commit: writes only handoff.md (plus caller-supplied files). No PDU application, no architecture.md mutation.
- `bootstrap.ts`: reads PDU as context only. No writes.
- `synthesize.ts` generatePendingDocUpdates(): writes proposals to file, no downstream consumer applies them.
- task-queue.md Recently Completed: zero cap, zero archive config. Grows unbounded.

This brief implements four enforcement mechanisms that, combined, eliminate all three maintenance classes permanently.

---

## Piece 1 — PDU Auto-Apply at Finalize Commit

**File:** `src/tools/finalize.ts` and new `src/utils/apply-pdu.ts`

**What to build:**

Create `src/utils/apply-pdu.ts` — a utility that:
1. Reads `.prism/pending-doc-updates.md` from the project repo via GitHub API
2. Parses `### Proposed:` sections — each section header is a proposal title, the body contains the rationale and an explicit `Apply via ...` instruction with a fenced code block containing the content to apply
3. For each proposal, determines the target file and operation (append/replace on a named section, or table-row insertion for glossary)
4. Applies each proposal as a direct GitHub commit to the target file
5. After all proposals applied successfully, overwrites `.prism/pending-doc-updates.md` with a cleared state:
   ```
   # Pending Doc Updates — [Project]

   > Auto-generated proposals. Operator review required before applying via `prism_patch`.
   > Last synthesized: [session]
   > Last applied: [current session] ([date])

   ## No Updates Needed

   <!-- EOF: pending-doc-updates.md -->
   ```
6. Returns a summary: `{ applied: string[], skipped: string[], errors: string[] }`

**Parsing strategy for proposals:**

The PDU file structure is:
```
## architecture.md
### Proposed: <title>
<rationale>
**Apply via `prism_patch <operation>` on `<section>`:**
```<content>```

## glossary.md
### Add term: <name>
**Body:**
```| term | ... | session |```
```

Parse by:
- Split on `## <filename>` headers to group proposals by target file
- Within each file group, split on `### Proposed:` or `### Add term:` to enumerate proposals
- Extract the fenced code block after `**Apply via` or `**Body:**` as the content payload
- Extract the target section name from the `Apply via` line (e.g., `### Synthesis Per-Call-Site Routing`)
- Map operation type: `append` if "append", `replace` if "replace", table-row insertion for glossary terms

**Glossary table-row insertion:** Find the last `|` row before `<!-- EOF -->` and insert the new row above the EOF comment.

**Wire into finalize.ts:**

After the existing `Promise.allSettled([generateIntelligenceBrief(...), generatePendingDocUpdates(...)])` fire-and-forget block (lines 779–781), add a synchronous (awaited) PDU apply step that runs BEFORE the synthesis fire-and-forget:

```typescript
// Apply pending-doc-updates proposals synchronously before firing background synthesis
if (allSucceeded && SYNTHESIS_ENABLED) {
  const pduResult = await applyPendingDocUpdates(projectSlug, sessionNumber);
  if (pduResult.applied.length > 0) {
    commitResponse.pdu_applied = pduResult.applied;
  }
  if (pduResult.errors.length > 0) {
    commitResponse.pdu_errors = pduResult.errors;
  }
}
```

This runs after the handoff commit lands, before background synthesis fires. Errors in PDU apply are non-fatal — log them, surface in response, but do not fail the commit.

**Error handling:** If a proposal's target section is not found in the target file, skip that proposal and add to `skipped` with reason. If a GitHub API write fails, add to `errors`. Never throw — PDU apply failure must not affect commit success.

---

## Piece 2 — Bootstrap Stale-PDU Safety Net

**File:** `src/tools/bootstrap.ts`

**What to build:**

In the bootstrap handler, after fetching PDU (currently lines 684–701), add a staleness check:

1. Parse the `> Last synthesized: S{N}` line from the fetched PDU content
2. Compare N to `(currentSessionNumber - 1)` — if the PDU is more than 1 session old AND non-empty (has `### Proposed:` or `### Add term:` sections), run `applyPendingDocUpdates()` before assembling the bootstrap response
3. Add a `pdu_applied_at_boot` field to the bootstrap response containing the apply summary
4. Surface in the boot banner warnings array: `"PDU stale ({N} sessions old) — {X} proposals auto-applied at boot."`

**Staleness definition:** PDU synthesized at session N, current bootstrap is session M. Stale if M > N+1 (skipped at least one finalization without applying).

**Note:** This is the safety net, not the primary path. Piece 1 is the primary path. Piece 2 catches cases where Piece 1 was skipped (e.g., `skip_synthesis: true` finalization, or PDU synthesis failed).

---

## Piece 3 — Architecture.md Timestamp and Version Auto-Write at Finalize

**File:** `src/tools/finalize.ts`

**What to build:**

Add a function `updateArchitectureMetadata(projectSlug, sessionNumber, sessionDate)` that:
1. Fetches `.prism/architecture.md` from the project repo
2. Updates the `> Updated: S{N} ({date})` preamble line — regex: `/^> Updated: S\d+ \([^)]+\)/m`
3. For the Stack version bullet (pattern: `- **MCP server:** Node.js/TypeScript on Railway (v`), appends the current session's brief number and version entry if not already present
4. Commits the updated file

**Trigger:** Call during `action: "commit"` processing, AFTER the main handoff commit succeeds, as part of the same post-commit block where PDU apply runs. Pass current session number and ISO date.

**Version detection:** Read `package.json` from the prism-mcp-server repo to get current version string. This is the ground truth.

**Scope restriction:** Gate on a `.prism/config.yaml` flag `auto_update_architecture: true`. Only process `architecture.md` files containing the `> Updated: S` preamble pattern. Skip silently otherwise. For the `prism` project, this flag should be set to `true` (CC should add it to `.prism/config.yaml` in the prism repo as a cross-repo edit, or note it as a follow-up operator action).

---

## Piece 4 — Task-Queue Recently Completed Cap

**File:** `src/tools/finalize.ts` and `src/config.ts`

**What to build:**

Add an archive config entry for `task-queue.md` in the `ARCHIVE_CONFIGS` array (`finalize.ts` lines 38–62):

```typescript
{
  file: 'task-queue.md',
  section: '## Recently Completed',
  maxEntries: 15,
  archiveFile: null,  // prune, don't archive
  trigger: 'entry_count'
}
```

Wire an `applyArchive()` call for task-queue.md alongside the existing session-log and insights archive calls (lines 694–695).

**Pruning behavior:** When `### ` entry count in `## Recently Completed` exceeds 15, remove oldest entries (bottom of section) until count = 15. Do not archive — old completed entries have no operational value.

**Section header:** The section is currently titled `## Recently Completed (last 10 sessions)`. The archive config should match on both the old and new form. When first pruning, update the section header to `## Recently Completed (last 15 sessions)` to reflect the new cap.

---

## Tests

Add test cases covering:
- `applyPendingDocUpdates`: parses architecture.md proposals correctly, applies append/replace, inserts glossary rows, clears PDU file on success, skips missing-section proposals gracefully, returns correct summary
- `applyPendingDocUpdates`: errors are non-fatal — partial success still clears applied proposals from PDU
- `updateArchitectureMetadata`: updates `> Updated:` preamble line, detects existing session entry to avoid duplicate, skips when pattern not found
- Task-queue archive: prunes to 15 entries, does not prune when count ≤ 15, handles both old and new section header titles
- Bootstrap stale-PDU detection: fires when PDU is 2+ sessions old with proposals, does not fire when PDU is current or empty

Test count baseline: 985. Expected delta: +12–18 tests.

---

## Acceptance Criteria

1. `prism_finalize action="commit"` on a project with non-empty PDU proposals → proposals applied to target files, PDU cleared, `pdu_applied` array in response
2. `prism_bootstrap` on a project with PDU stale by 2+ sessions → proposals auto-applied, warning surfaced in `warnings[]`
3. `prism_finalize action="commit"` on project with `auto_update_architecture: true` → architecture.md `> Updated:` line reflects current session
4. `## Recently Completed` section never exceeds 15 entries after finalization
5. All four behaviors are non-fatal — failure in any one does not affect commit or bootstrap primary response
6. All existing 985 tests pass

---

## Version

Bump `package.json` version to `4.7.0`. Update CHANGELOG if present.

---

## PR

Title: `feat: living-doc enforcement — PDU auto-apply, architecture timestamps, task-queue cap (brief-422)`  
Base: `main`

<!-- EOF: brief-422-living-doc-enforcement.md -->