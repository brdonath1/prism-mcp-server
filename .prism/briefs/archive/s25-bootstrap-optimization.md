# CC Brief: S25 Bootstrap Payload Optimization (D-47)

## Context
Fresh-eyes review identified that bootstrap delivers ~42KB of context before work begins (~21% of context window). Three components account for ~60% of the payload and are compressible without losing actionable intelligence. This brief implements all three optimizations plus per-component monitoring.

Estimated savings: ~19KB (~45% reduction). Bootstrap drops from ~42KB to ~23KB.

## Pre-Flight
- [ ] Read `src/tools/bootstrap.ts` — main file being modified
- [ ] Read `src/utils/summarizer.ts` — `extractSection` is used for compact brief
- [ ] Read `src/utils/banner.ts` — understand current `renderBannerHtml` usage
- [ ] Run `npm run build` to confirm clean baseline

## Changes

### Change 1: Standing Rules — Procedure-Only Extraction

**File:** `src/tools/bootstrap.ts`

Update the `StandingRule` interface:

```typescript
interface StandingRule {
  id: string;
  title: string;
  procedure: string; // D-47: procedure-only, not full content
}
```

Rewrite `extractStandingRules` to extract only the procedure portion:

```typescript
function extractStandingRules(insightsContent: string | null): StandingRule[] {
  if (!insightsContent) return [];

  const rules: StandingRule[] = [];
  const sections = insightsContent.split(/(?=^### )/m);

  for (const section of sections) {
    if (/standing\s+rule/i.test(section)) {
      const headerMatch = section.match(/^### (INS-\d+):?\s*(.+)/);
      if (headerMatch) {
        // D-47: Extract procedure-only — find "Standing procedure:" and take everything after
        let procedure = '';
        const procStart = section.search(/\*\*Standing procedure:\*\*/i);
        if (procStart !== -1) {
          procedure = section.slice(procStart)
            .replace(/^\*\*Standing procedure:\*\*\s*/i, '')
            .trim();
        }

        rules.push({
          id: headerMatch[1],
          title: headerMatch[2].replace(/\s*—\s*STANDING RULE\s*/i, '').trim(),
          procedure,
        });
      }
    }
  }

  return rules;
}
```

Key behaviors:
- Splits insights.md by `### ` headers (same as before)
- Filters for sections containing "STANDING RULE" (same as before)
- NEW: Finds `**Standing procedure:**` marker and extracts only the text after it
- NEW: Strips " — STANDING RULE" suffix from title for cleaner display
- Falls back to empty string if no procedure marker found (shouldn't happen)

### Change 2: Intelligence Brief — Compact Mode

**File:** `src/tools/bootstrap.ts`

After the existing intelligence brief fetch block (around the "5. Intelligence brief loading" comment), add compact extraction:

```typescript
// 5. Intelligence brief loading (Track 2, D-44)
let intelligenceBrief: string | null = null;
let intelligenceBriefFull: string | null = null; // D-47: keep full for size tracking
try {
  const briefFile = await fetchFile(resolvedSlug, "intelligence-brief.md");
  intelligenceBriefFull = briefFile.content;
  filesFetched++;
  logger.info("intelligence brief loaded", { size: briefFile.size });

  // D-47: Compact mode — extract only actionable sections
  const projectState = extractSection(briefFile.content, "Project State");
  const riskFlags = extractSection(briefFile.content, "Risk Flags");
  const qualityAudit = extractSection(briefFile.content, "Quality Audit");

  const compactParts: string[] = [];
  if (projectState) {
    // First 3 sentences only for project state context
    const sentences = projectState.split(/(?<=[.!?])\s+/).slice(0, 3);
    compactParts.push(`**Project State (compact):** ${sentences.join(" ")}`);
  }
  if (riskFlags) compactParts.push(`## Risk Flags\n${riskFlags}`);
  if (qualityAudit) compactParts.push(`## Quality Audit\n${qualityAudit}`);

  intelligenceBrief = compactParts.length > 0 ? compactParts.join("\n\n") : null;

  if (intelligenceBrief) {
    bytesDelivered += intelligenceBrief.length; // Count compact size, not full
    logger.info("intelligence brief compacted", {
      fullSize: briefFile.size,
      compactSize: intelligenceBrief.length,
      sectionsExtracted: compactParts.length,
    });
  }
} catch {
  // intelligence-brief.md may not exist yet
}
```

IMPORTANT: Remove the existing `bytesDelivered += briefFile.size` line from the original code — the compact version adds the compact size instead.

### Change 3: Banner — Data Object Instead of Pre-Rendered HTML

**File:** `src/tools/bootstrap.ts`

Replace the entire banner HTML rendering block (the section starting with "6. Render boot banner HTML") with a data object construction:

```typescript
// 6. Banner data object (D-47 — replaces pre-rendered HTML)
const projectDisplayName = getProjectDisplayName(resolvedSlug);
const resumption = parseResumptionForBanner(resumptionPoint, currentState);
const guardrailCount = guardrails.length;
const docCount = LIVING_DOCUMENTS.length;
const docTotal = LIVING_DOCUMENTS.length;
const docStatus = docCount === docTotal ? "ok" as const : "critical" as const;
const docLabel = docStatus === "ok" ? "healthy" : `${docTotal - docCount} missing`;

const pushToolStatus = bootTestResult.success ? "ok" as const : "warn" as const;
const pushToolLabel = bootTestResult.success ? "push verified" : "push failed";
if (!bootTestResult.success) {
  warnings.push(`Boot-test push failed: ${bootTestResult.error}`);
}

const bannerData = {
  template_version: handoffTemplateVersion,
  project: projectDisplayName,
  session: sessionNumber,
  timestamp: sessionTimestamp,
  handoff_version: handoffVersion,
  handoff_kb: (handoff.size / 1024).toFixed(1),
  decisions: decisions.length,
  guardrails: guardrailCount,
  docs: `${docCount}/${docTotal}`,
  doc_status: docStatus,
  doc_label: docLabel,
  tools: [
    { label: "bootstrap", status: "ok" },
    { label: pushToolLabel, status: pushToolStatus },
    { label: "template loaded", status: "ok" },
    { label: scalingRequired ? "scaling required" : "no scaling needed", status: scalingRequired ? "warn" : "ok" },
  ],
  resumption,
  next_steps: nextSteps.map((text, i) => ({
    text,
    priority: i === 0,
  })),
  warnings,
};
```

Remove the `renderBannerHtml` import if no other code in this file uses it. (Check — it may still be used elsewhere. If so, keep the import.)

Remove the `bannerHtml` variable declaration and its try/catch block.

### Change 4: Per-Component Sizing

**File:** `src/tools/bootstrap.ts`

Before building the result object, add:

```typescript
// D-47: Per-component sizing for monitoring
const componentSizes = {
  handoff: handoff.size,
  decisions_index: coreResults[1].status === "fulfilled" && coreResults[1].value ? (coreResults[1].value as { size: number }).size : 0,
  behavioral_rules: coreResults[2].status === "fulfilled" && coreResults[2].value ? (coreResults[2].value as { size: number }).size : 0,
  intelligence_brief_full: intelligenceBriefFull?.length ?? 0,
  intelligence_brief_compact: intelligenceBrief?.length ?? 0,
  standing_rules: JSON.stringify(standingRules).length,
  banner_data: JSON.stringify(bannerData).length,
  prefetched_docs: prefetchedDocuments.reduce((sum, d) => sum + d.size_bytes, 0),
};
```

Note: The `coreResults` type assertions may need adjustment depending on TypeScript strictness. Use the actual return types from `fetchFile` and `fetchBehavioralRules`.

### Change 5: Update Result Object

Replace the current result object with:

```typescript
const result = {
  project: resolvedSlug,
  handoff_version: handoffVersion,
  template_version: handoffTemplateVersion,
  session_count: sessionCount,
  session_number: sessionNumber,
  session_timestamp: sessionTimestamp,
  handoff_size_bytes: handoff.size,
  scaling_required: scalingRequired,
  critical_context: criticalContext,
  current_state: currentState,
  resumption_point: resumptionPoint,
  recent_decisions: recentDecisions,
  guardrails,
  next_steps: nextSteps,
  open_questions: openQuestions,
  prefetched_documents: prefetchedDocuments,
  standing_rules: standingRules,
  intelligence_brief: intelligenceBrief,      // D-47: compact version
  behavioral_rules: behavioralRules,
  banner_data: bannerData,                     // D-47: data object replaces banner_html
  banner_html: null,                           // D-47: null for backward compat detection
  boot_test_verified: bootTestResult.success,
  bytes_delivered: bytesDelivered,
  files_fetched: filesFetched,
  component_sizes: componentSizes,             // D-47: per-component monitoring
  warnings,
};
```

### Change 6: Update Logger

Add component sizes to the final log:

```typescript
logger.info("prism_bootstrap complete", {
  project_slug: resolvedSlug,
  filesFetched,
  bytesDelivered,
  rulesDelivered: !!behavioralRules,
  rulesCached: templateCache.get(MCP_TEMPLATE_PATH) !== null,
  bannerDataDelivered: true,                   // D-47
  standingRulesCount: standingRules.length,
  intelligenceBriefCompacted: !!intelligenceBrief, // D-47
  intelligenceBriefFullSize: intelligenceBriefFull?.length ?? 0,  // D-47
  intelligenceBriefCompactSize: intelligenceBrief?.length ?? 0,   // D-47
  bootTestVerified: bootTestResult.success,
  componentSizes,                              // D-47
  ms: Date.now() - start,
});
```

## Verification
- [ ] `npm run build` succeeds with no TypeScript errors
- [ ] Start the server locally and call `prism_bootstrap` for any project
- [ ] Verify response has `banner_data` object (not null) with fields: template_version, project, session, timestamp, handoff_version, handoff_kb, decisions, guardrails, docs, doc_status, doc_label, tools, resumption, next_steps, warnings
- [ ] Verify `banner_html` is `null`
- [ ] Verify `intelligence_brief` is compact (should be significantly shorter than `component_sizes.intelligence_brief_full`)
- [ ] Verify `intelligence_brief` contains Risk Flags and Quality Audit sections but NOT Recent Trajectory or Standing Rules & Workflows
- [ ] Verify `standing_rules` entries have `id`, `title`, `procedure` fields (NO `content` field)
- [ ] Verify `standing_rules[].procedure` contains actionable steps, not full discovery context
- [ ] Verify `component_sizes` is present with all numeric values
- [ ] Verify `bytes_delivered` reflects compact sizes (should be noticeably smaller than before)
- [ ] Full intelligence brief still fetchable via `prism_fetch` with path `intelligence-brief.md`
- [ ] Health check endpoint still responds at `/health`

## Post-Flight
- [ ] `git add -A && git commit -m "perf: D-47 bootstrap optimization — banner data, compact brief, procedure-only rules" && git push`
- [ ] Wait for Railway auto-deploy to complete
- [ ] After deploy: disconnect and reconnect PRISMv2 MCP Server connector in Claude.ai Settings (INS-11)
- [ ] Start a new conversation to verify (INS-10)

**Template update (separate step after server verification):**
After confirming the server changes work, the core template (`prism-framework/_templates/core-template-mcp.md`) needs Rule 2's banner section updated to reference `banner_data` instead of `banner_html`. This will be handled in the next PRISM session after server deploy is verified. The existing template's fallback path handles `banner_html: null` gracefully in the interim.

<!-- EOF: s25-bootstrap-optimization.md -->
