# CC Brief: S25 Standing Rules Source Fix

## Context
D-47 bootstrap optimization introduced a bug: standing rules are extracted from `intelligenceBriefFull` (intelligence-brief.md) instead of `insights.md`. The intelligence brief doesn't contain `### INS-N:` headers, so the regex never matches and returns an empty array. Standing rules must come from insights.md.

## Pre-Flight
- [ ] Read `src/tools/bootstrap.ts` — locate the standing rules extraction section

## Changes

**File:** `src/tools/bootstrap.ts`

The current code has:

```typescript
// 5b. Standing rules extraction (D-47)
const standingRules = extractStandingRules(intelligenceBriefFull);
```

Replace the `// 5b. Standing rules extraction (D-47)` section with:

```typescript
// 5b. Standing rules extraction from insights.md (D-44 Track 1, D-47)
let insightsContent: string | null = null;
try {
  const insightsFile = await fetchFile(resolvedSlug, "insights.md");
  insightsContent = insightsFile.content;
  // Don't add to bytesDelivered — only extracted procedures are delivered, not full file
} catch {
  // insights.md may not exist for this project
}
const standingRules = extractStandingRules(insightsContent);
if (standingRules.length > 0) {
  logger.info("standing rules extracted", { count: standingRules.length, ids: standingRules.map(r => r.id) });
}
```

This restores the original insights.md fetch that was present before D-47 but was accidentally dropped during reorganization.

## Verification
- [ ] `npm run build` succeeds
- [ ] Call `prism_bootstrap` for the `prism` project
- [ ] Verify `standing_rules` is a non-empty array (should have 5 entries: INS-6, INS-7, INS-8, INS-10, INS-11)
- [ ] Verify each entry has `id`, `title`, and `procedure` fields
- [ ] Verify `procedure` contains actionable steps (not full discovery context)

## Post-Flight
- [ ] `git add -A && git commit -m "fix: standing rules extracted from insights.md not intelligence-brief (D-47)" && git push`
- [ ] Wait for Railway deploy
- [ ] Disconnect and reconnect PRISMv2 MCP Server connector (INS-11)
- [ ] Verify in new conversation or via mid-conversation bootstrap call

<!-- EOF: s25-standing-rules-fix.md -->
