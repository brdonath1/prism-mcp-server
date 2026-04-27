# CC Brief: KI-11 Fix — scale_handoff Scaling Logic Not Redistributing Content

> ## Launch Command
> ```bash
> claude --dangerously-skip-permissions --model claude-opus-4-6 --effort max
> ```
> **Pre-launch:** `cd ~/Desktop/Development/prism-mcp-server && git add -A && git commit -m "checkpoint: pre-ki11-fix"`

---

## Mission

Fix KI-11: `prism_scale_handoff` completes without timeout (KI-10 fixed) but does NOT actually scale the handoff. A 20.4KB handoff with 46 inline decisions goes in and comes out at 20.4KB with `reduction_percent: 0`. The tool runs as a passthrough — it pushes files but does not analyze handoff content, identify sections to extract, or compose leaner versions.

**Evidence:** Stress test on `snapquote-ai` with a 20.4KB handoff containing 46 inline decisions. Tool returned `before_size_bytes: 20395, after_size_bytes: 20395, reduction_percent: 0` in 1.8 seconds. For comparison, manual scaling of the same handoff in Session 10 achieved 63% reduction (20KB to 7.4KB) by extracting decisions to `decisions/_INDEX.md`, condensing session history, and leaning Critical Context.

**The fix:** The scaling logic in `src/tools/scale.ts` must actually parse the handoff content, identify redistributable sections, compose leaned content, and push both the leaned handoff and the extracted living documents.

Do NOT ask questions. All decisions are pre-made below.

---

## What Manual Scaling Does (the reference implementation)

When a human manually scales a handoff, these are the specific operations:

1. **Extract inline decisions to `decisions/_INDEX.md`:** If the handoff contains a `## Active Decisions` or `## Decisions` section with individual decision entries (D-1, D-2, etc.), move ALL of them to `decisions/_INDEX.md`. Replace the handoff section with a summary table (last 5-8 decisions) + pointer: `*N total decisions -- full index: decisions/_INDEX.md*`

2. **Extract verbose session history to `session-log.md`:** If `## Session History` has more than 3-5 entries, move older entries to `session-log.md`. Keep only the last 3 sessions in the handoff with condensed format (1-2 lines each) + pointer.

3. **Extract artifacts registry to living docs:** If `## Artifacts Registry` has a large table, move it to `architecture.md` or a dedicated artifacts file. Keep only actively-referenced artifacts in the handoff.

4. **Extract open questions:** If `## Open Questions` has many items, move resolved ones to session-log and keep only active questions.

5. **Condense Critical Context:** Remove items that are now embedded in living documents. Keep only the 3-5 items that would break things if forgotten.

6. **Condense Strategic Direction:** Reduce to 1-2 sentences if verbose.

7. **Condense Where We Are:** Reduce to a specific resumption point, not a narrative.

8. **Remove duplicate EOF sentinels:** Some handoffs have `<!-- EOF: handoff.md -->` appearing twice.

**Target: under 8KB.** The goal is a handoff that loads in ~2% context instead of ~10%.

---

## Task Checklist

### Task 1: Read and understand the current scale.ts
- [ ] Read `src/tools/scale.ts` completely
- [ ] Identify why `reduction_percent` is 0 — is the analysis step missing? Is it analyzing but finding nothing? Is the composition step a no-op?
- [ ] Document what the current code actually does vs what it should do

### Task 2: Implement handoff content analysis
The tool must parse the handoff markdown and identify these redistributable sections:

- [ ] **Inline decisions section:** Look for `## Active Decisions`, `## Decisions`, or any section containing `### D-N:` patterns. Count decisions. If >8, flag for extraction.
- [ ] **Session history:** Look for `## Session History`. Count session entries (lines starting with `### Session`). If >3, flag older entries for extraction.
- [ ] **Artifacts registry:** Look for `## Artifacts Registry`. If section >2KB, flag for extraction.
- [ ] **Open questions:** Look for `## Open Questions`. Count items. If >10, flag resolved (checked `[x]`) items for removal.
- [ ] **Verbose sections:** Measure byte size of each `##` section. Flag any section >2KB for condensation.
- [ ] **Duplicate EOF:** Check for multiple `<!-- EOF:` occurrences.

Return an analysis object:
```typescript
{
  total_size: number,
  sections: {
    name: string,
    size_bytes: number,
    action: 'extract' | 'condense' | 'keep',
    target_file?: string,  // e.g., 'decisions/_INDEX.md'
    items_to_move?: number
  }[],
  estimated_reduction_percent: number
}
```

### Task 3: Implement content extraction
For each section flagged for extraction:

- [ ] **Decisions -> decisions/_INDEX.md:** Parse each `### D-N:` block. Fetch existing `decisions/_INDEX.md` (if any). Merge new decisions into the index (avoid duplicates by checking D-N IDs). Replace handoff section with summary table of last 5 decisions + count + pointer.
- [ ] **Session history -> session-log.md:** Parse each `### Session N` block. Fetch existing `session-log.md` (if any). Append older sessions. Keep last 3 in handoff with 1-line summaries + pointer.
- [ ] **Artifacts -> architecture.md:** Move artifacts table to architecture.md under `## Artifacts Registry` section.

### Task 4: Implement content condensation
For sections flagged for condensation:

- [ ] **Critical Context:** Keep maximum 5 items. Remove items that are purely informational (not "breaks things if forgotten").
- [ ] **Strategic Direction:** Truncate to first paragraph if >500 bytes.
- [ ] **Where We Are:** Keep the first 2-3 sentences only. Remove narrative.
- [ ] **Open Questions:** Remove all `[x]` checked items.
- [ ] **Duplicate EOF:** Remove all but the last one.

### Task 5: Compose and push
- [ ] Compose the leaned handoff from the remaining sections
- [ ] Push ALL modified files (leaned handoff + any living docs that received extracted content)
- [ ] Report `before_size_bytes`, `after_size_bytes`, `reduction_percent` accurately
- [ ] If `after_size_bytes` > 8192 (8KB), add a warning that further manual intervention may be needed

### Task 6: Add/update tests
- [ ] Add a test with a mock 20KB handoff containing 46 inline decisions, 16 session entries, and an artifacts table
- [ ] Verify the analysis identifies all redistributable sections
- [ ] Verify the composed handoff is under 8KB
- [ ] Verify decision extraction produces valid `_INDEX.md` content
- [ ] Verify session extraction produces valid `session-log.md` content
- [ ] Run full test suite: `npm test`

### Task 7: Build, test, commit
- [ ] `npm run build` — zero errors
- [ ] `npm test` — all tests pass
- [ ] Local smoke test:
  ```bash
  node dist/index.js &
  sleep 2
  curl -s http://localhost:3000/health
  kill %1
  ```
- [ ] `git add -A && git commit -m "fix: KI-11 scale_handoff scaling logic -- content analysis, extraction, condensation" && git push origin main`

---

## Test Data

A real 20.4KB handoff with 46 inline decisions is available at:
`brdonath1/snapquote-ai/handoff-history/handoff_v16_2026-03-27.md`

Fetch it via GitHub API for use in tests:
```bash
curl -s -H "Authorization: Bearer $GITHUB_PAT" \
  -H "Accept: application/vnd.github.raw+json" \
  "https://api.github.com/repos/brdonath1/snapquote-ai/contents/handoff-history/handoff_v16_2026-03-27.md"
```

---

## Completion Criteria

1. `npm run build` — zero errors
2. `npm test` — all tests pass
3. A mock 20KB handoff with 46 decisions is reduced to <8KB by the tool
4. Extracted decisions are properly formatted for `_INDEX.md`
5. Extracted sessions are properly formatted for `session-log.md`
6. `reduction_percent` is >50% on the test data
7. Changes committed and pushed

---

## What NOT to Do

- Do NOT modify any tool other than `prism_scale_handoff` (scale.ts)
- Do NOT change the tool's external interface (keep `project_slug` + `dry_run`)
- Do NOT add new npm dependencies
- Do NOT modify the Express server or other tools
- Do NOT delete or modify existing tests — only add new ones

<!-- EOF: ki11-scale-logic-fix.md -->