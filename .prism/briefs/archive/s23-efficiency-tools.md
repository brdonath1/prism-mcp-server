# Brief: S23 Session Efficiency Tools

> 5 enhancements to reduce token cost and improve quality during work and finalization.
> Consolidated brief — 3 new tools + modifications to 4 existing files.

## Pre-Flight

1. Verify server health: `curl https://prism-mcp-server-production.up.railway.app/health` → should return `{"status":"ok","version":"2.8.0"}`
2. Verify `@anthropic-ai/sdk` is in package.json dependencies (added in S22)
3. Run `npm run build` — confirm no existing errors
4. Run `npm test` if tests exist — confirm baseline passes

## Changes

### 1. NEW FILE: src/tools/log-decision.ts

Create this file with the following content:

```typescript
/**
 * prism_log_decision — Log a decision to both _INDEX.md and domain file atomically.
 * Eliminates full-file roundtrips for decision logging.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchFile, pushFile } from "../github/client.js";
import { logger } from "../utils/logger.js";

export function registerLogDecision(server: McpServer): void {
  server.tool(
    "prism_log_decision",
    "Log a decision to both decisions/_INDEX.md and decisions/{domain}.md atomically. Handles formatting and table insertion server-side.",
    {
      project_slug: z.string().describe("Project repo name"),
      id: z.string().describe("Decision ID (e.g., 'D-45')"),
      title: z.string().describe("Decision title"),
      domain: z.string().describe("Decision domain (e.g., 'architecture', 'operations', 'optimization')"),
      status: z.string().describe("Decision status (e.g., 'SETTLED', 'OPEN')"),
      reasoning: z.string().describe("Full reasoning text for the decision entry"),
      assumptions: z.string().optional().describe("Assumptions (if any)"),
      impact: z.string().optional().describe("Impact description (if any)"),
      session: z.number().describe("Session number where decision was made"),
    },
    async ({ project_slug, id, title, domain, status, reasoning, assumptions, impact, session }) => {
      const start = Date.now();
      logger.info("prism_log_decision", { project_slug, id, domain });

      try {
        // 1. Fetch current _INDEX.md
        let indexContent: string;
        try {
          const indexFile = await fetchFile(project_slug, "decisions/_INDEX.md");
          indexContent = indexFile.content;
        } catch {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "decisions/_INDEX.md not found" }) }],
            isError: true,
          };
        }

        // 2. Insert new row into the table (before EOF sentinel)
        const newRow = `| ${id} | ${title} | ${domain} | ${status} | ${session} |`;
        const eofSentinel = "<!-- EOF: _INDEX.md -->";

        if (indexContent.includes(eofSentinel)) {
          indexContent = indexContent.replace(eofSentinel, `${newRow}\n${eofSentinel}`);
        } else {
          indexContent = indexContent.trimEnd() + `\n${newRow}\n`;
        }

        // 3. Fetch or create domain file
        const domainPath = `decisions/${domain}.md`;
        let domainContent: string;
        try {
          const domainFile = await fetchFile(project_slug, domainPath);
          domainContent = domainFile.content;
        } catch {
          domainContent = `# Decisions — ${domain}\n\n> Domain: ${domain}\n> Full decision entries. See _INDEX.md for lookup table.\n\n<!-- EOF: ${domain}.md -->\n`;
        }

        // 4. Build full decision entry
        const entryLines = [
          `### ${id}: ${title}`,
          `- Domain: ${domain}`,
          `- Status: ${status}`,
          `- Reasoning: ${reasoning}`,
        ];
        if (assumptions) entryLines.push(`- Assumptions: ${assumptions}`);
        if (impact) entryLines.push(`- Impact: ${impact}`);
        entryLines.push(`- Decided: Session ${session}`);

        const entry = entryLines.join("\n");
        const domainEof = `<!-- EOF: ${domain}.md -->`;

        if (domainContent.includes(domainEof)) {
          domainContent = domainContent.replace(domainEof, `${entry}\n\n${domainEof}`);
        } else {
          domainContent = domainContent.trimEnd() + `\n\n${entry}\n\n${domainEof}\n`;
        }

        // 5. Push both files
        const indexResult = await pushFile(
          project_slug,
          "decisions/_INDEX.md",
          indexContent,
          `prism: ${id} ${title}`
        );

        const domainResult = await pushFile(
          project_slug,
          domainPath,
          domainContent,
          `prism: ${id} full entry`
        );

        logger.info("prism_log_decision complete", {
          project_slug, id, domain,
          indexSuccess: indexResult.success,
          domainSuccess: domainResult.success,
          ms: Date.now() - start,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              id,
              title,
              domain,
              status,
              index_updated: indexResult.success,
              domain_file_updated: domainResult.success,
              domain_file: domainPath,
            }),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_log_decision failed", { project_slug, id, error: message });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );
}
```

---

### 2. NEW FILE: src/tools/log-insight.ts

Create this file with the following content:

```typescript
/**
 * prism_log_insight — Log an insight to insights.md with STANDING RULE support.
 * Eliminates full-file roundtrips for insight capture.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchFile, pushFile } from "../github/client.js";
import { logger } from "../utils/logger.js";

export function registerLogInsight(server: McpServer): void {
  server.tool(
    "prism_log_insight",
    "Log an insight to insights.md. Handles formatting and section placement server-side. Supports STANDING RULE tagging for D-44 Track 1 auto-loading at bootstrap.",
    {
      project_slug: z.string().describe("Project repo name"),
      id: z.string().describe("Insight ID (e.g., 'INS-12')"),
      title: z.string().describe("Insight title"),
      category: z.string().describe("Category (e.g., 'pattern', 'gotcha', 'preference', 'exploration', 'operations')"),
      description: z.string().describe("Full description of the insight"),
      session: z.number().describe("Session number where insight was discovered"),
      standing_rule: z.boolean().optional().describe("Whether this is a STANDING RULE (auto-loaded at bootstrap via D-44 Track 1)"),
      procedure: z.string().optional().describe("Standing procedure steps (required if standing_rule is true). Use numbered steps."),
    },
    async ({ project_slug, id, title, category, description, session, standing_rule, procedure }) => {
      const start = Date.now();
      logger.info("prism_log_insight", { project_slug, id, standing_rule });

      try {
        // Validate: standing rules must have procedures
        if (standing_rule && !procedure) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "standing_rule entries require a procedure field" }) }],
            isError: true,
          };
        }

        // 1. Fetch current insights.md
        let content: string;
        try {
          const file = await fetchFile(project_slug, "insights.md");
          content = file.content;
        } catch {
          content = `# Insights — ${project_slug}\n\n> Institutional knowledge. Entries tagged **STANDING RULE** are auto-loaded at bootstrap (D-44 Track 1).\n\n## Active\n\n## Formalized\n\n<!-- EOF: insights.md -->\n`;
        }

        // 2. Build the entry
        const standingTag = standing_rule ? " — STANDING RULE" : "";
        const categoryTag = standing_rule ? `${category} — **STANDING RULE**` : category;

        const entryLines = [
          `### ${id}: ${title}${standingTag}`,
          `- Category: ${categoryTag}`,
          `- Discovered: Session ${session}`,
          `- Description: ${description}`,
        ];

        if (standing_rule && procedure) {
          entryLines.push(`- **Standing procedure:** ${procedure}`);
        }

        const entry = entryLines.join("\n");

        // 3. Insert into ## Active section (before ## Formalized or EOF)
        const formalizedMarker = "## Formalized";
        const eofSentinel = "<!-- EOF: insights.md -->";

        if (content.includes(formalizedMarker)) {
          content = content.replace(formalizedMarker, `${entry}\n\n${formalizedMarker}`);
        } else if (content.includes(eofSentinel)) {
          content = content.replace(eofSentinel, `${entry}\n\n${eofSentinel}`);
        } else {
          content = content.trimEnd() + `\n\n${entry}\n`;
        }

        // 4. Push
        const result = await pushFile(
          project_slug,
          "insights.md",
          content,
          `prism: ${id} ${title}`
        );

        logger.info("prism_log_insight complete", {
          project_slug, id, standing_rule: !!standing_rule,
          success: result.success,
          ms: Date.now() - start,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              id,
              title,
              category,
              standing_rule: !!standing_rule,
              success: result.success,
              size_bytes: result.size,
            }),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_log_insight failed", { project_slug, id, error: message });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );
}
```

---

### 3. NEW FILE: src/tools/patch.ts

Create this file with the following content:

```typescript
/**
 * prism_patch — Section-level file operations without full-file roundtrips.
 * Supports append, prepend, and replace on markdown sections.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchFile, pushFile } from "../github/client.js";
import { logger } from "../utils/logger.js";

/**
 * Apply a single patch operation to file content.
 * Finds the target section by header and applies the operation.
 */
function applyPatch(
  content: string,
  sectionHeader: string,
  operation: "append" | "prepend" | "replace",
  patchContent: string
): string {
  const headerLevel = (sectionHeader.match(/^#+/) ?? [""])[0].length;
  if (headerLevel === 0) {
    throw new Error(`Invalid section header: "${sectionHeader}" — must start with #`);
  }

  // Find the section: starts at the header, ends at next header of same/higher level, EOF sentinel, or end of string
  const escapedHeader = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRegex = new RegExp(
    `(${escapedHeader}[^\\n]*\\n)([\\s\\S]*?)(?=(?:^#{1,${headerLevel}} )|<!-- EOF:|$)`,
    "m"
  );

  const match = content.match(sectionRegex);
  if (!match) {
    throw new Error(`Section not found: "${sectionHeader}"`);
  }

  const [fullMatch, header, body] = match;
  const matchIndex = content.indexOf(fullMatch);

  let newSection: string;
  switch (operation) {
    case "append":
      newSection = header + body.trimEnd() + "\n" + patchContent + "\n\n";
      break;
    case "prepend":
      newSection = header + patchContent + "\n" + body;
      break;
    case "replace":
      newSection = header + patchContent + "\n\n";
      break;
  }

  return content.substring(0, matchIndex) + newSection + content.substring(matchIndex + fullMatch.length);
}

export function registerPatch(server: McpServer): void {
  server.tool(
    "prism_patch",
    "Apply section-level operations to a living document without full-file roundtrips. Supports append (add to end of section), prepend (add to start of section), and replace (replace entire section content). Multiple patches applied sequentially — all-or-nothing (if any patch fails, file is not modified).",
    {
      project_slug: z.string().describe("Project repo name"),
      file: z.string().describe("File path relative to repo root (e.g., 'task-queue.md')"),
      patches: z.array(z.object({
        operation: z.enum(["append", "prepend", "replace"]).describe("Operation type"),
        section: z.string().describe("Section header to target (e.g., '## In Progress', '### Session 22')"),
        content: z.string().describe("Content to append/prepend/replace with"),
      })).describe("One or more patch operations to apply sequentially"),
    },
    async ({ project_slug, file, patches }) => {
      const start = Date.now();
      logger.info("prism_patch", { project_slug, file, patchCount: patches.length });

      try {
        // 1. Fetch the current file
        const fileResult = await fetchFile(project_slug, file);
        let content = fileResult.content;

        // 2. Apply each patch
        const results: Array<{ operation: string; section: string; success: boolean; error?: string }> = [];

        for (const patch of patches) {
          try {
            content = applyPatch(content, patch.section, patch.operation, patch.content);
            results.push({ operation: patch.operation, section: patch.section, success: true });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push({ operation: patch.operation, section: patch.section, success: false, error: msg });
          }
        }

        // If any patch failed, don't push
        if (results.some(r => !r.success)) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "One or more patches failed — file not modified",
                results,
              }),
            }],
            isError: true,
          };
        }

        // 3. Push the updated file
        const pushResult = await pushFile(
          project_slug,
          file,
          content,
          `prism: patch ${file} (${patches.length} ops)`
        );

        logger.info("prism_patch complete", {
          project_slug, file,
          success: pushResult.success,
          patchCount: patches.length,
          ms: Date.now() - start,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              file,
              success: pushResult.success,
              size_bytes: pushResult.size,
              patches_applied: results,
            }),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_patch failed", { project_slug, file, error: message });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );
}
```

---

### 4. MODIFY: src/index.ts

Add three new imports after the existing tool imports:

```typescript
import { registerLogDecision } from "./tools/log-decision.js";
import { registerLogInsight } from "./tools/log-insight.js";
import { registerPatch } from "./tools/patch.js";
```

Add three new registrations inside `createServer()`, after `registerSynthesize(server);`:

```typescript
  registerLogDecision(server);
  registerLogInsight(server);
  registerPatch(server);
```

---

### 5. MODIFY: src/ai/prompts.ts

Add these two exports at the end of the file (before the closing):

```typescript
/**
 * System prompt for finalization draft generation.
 * Produces structured JSON drafts for session log, handoff updates, and task queue.
 */
export const FINALIZATION_DRAFT_PROMPT = `You are the PRISM Finalization Draft Engine. Read all living documents and session commit history, then produce draft content for session finalization.

Produce a JSON object with EXACTLY this structure (no preamble, no markdown fences, no explanation — ONLY valid JSON):

{
  "session_log_entry": "Complete ### Session N entry in markdown. Include **Focus:** line, **Key outcomes:** as bullet list, and **Discussion notes:** as 2-3 sentences of exploration context. Match the exact format of previous entries in session-log.md.",
  "handoff_where_we_are": "Updated 'Where We Are' section for the handoff. Be specific about what this session accomplished and where things stand now. Include a resumption point specific enough for a fresh Claude to continue.",
  "handoff_next_steps": ["3-5 specific, actionable next steps. Most important first. Each must be executable without additional context."],
  "handoff_session_history": "S{N}: One-line summary for the session history section",
  "task_queue_completed": ["Tasks that appear completed this session based on commit history and document changes. Use exact task descriptions from the existing task queue where possible."],
  "task_queue_new": ["New tasks identified during the session. Include section target (Up Next or Parking Lot) as a prefix like '[Up Next] task description'."]
}

RULES:
- Output ONLY valid JSON. No preamble, no markdown fences, no explanation outside the JSON.
- Be specific and dense. Every sentence must carry information.
- Session log Discussion notes: capture explorations, pivots, and reasoning context beyond formal decisions.
- Only mark tasks completed if clear evidence exists in commits or document changes.
- New tasks: only include things explicitly discussed or logically following from session work.
- Match formatting conventions from existing documents exactly.`;

/**
 * Build the user message for finalization draft generation.
 */
export function buildFinalizationDraftMessage(
  projectSlug: string,
  sessionNumber: number,
  documents: Map<string, { content: string; size: number }>,
  sessionCommits: string[]
): string {
  const parts: string[] = [
    `Project: ${projectSlug}`,
    `Session to finalize: S${sessionNumber}`,
    `\nCommits this session (${sessionCommits.length}):`,
    ...sessionCommits.map(m => `  - ${m}`),
    `\n---\nLIVING DOCUMENTS:\n`,
  ];

  for (const [path, doc] of documents) {
    parts.push(`\n### FILE: ${path} (${doc.size} bytes)\n`);
    parts.push(doc.content);
    parts.push(`\n--- END ${path} ---\n`);
  }

  return parts.join("\n");
}
```

---

### 6. MODIFY: src/tools/finalize.ts

Three changes to this file:

**Change 6a:** Add import for the new draft prompt functions. Find the existing import block near the top and add:

```typescript
import { FINALIZATION_DRAFT_PROMPT, buildFinalizationDraftMessage } from "../ai/prompts.js";
import { synthesize } from "../ai/client.js";
```

Note: `generateIntelligenceBrief` import from `"../ai/synthesize.js"` should remain unchanged.

**Change 6b:** Add a `draftPhase` function. Place it after the `auditPhase` function and before the `commitPhase` function:

```typescript
/**
 * Draft phase — use Opus 4.6 to generate finalization file drafts.
 * Returns structured content for Claude to review before commit.
 */
async function draftPhase(projectSlug: string, sessionNumber: number) {
  if (!SYNTHESIS_ENABLED) {
    return {
      success: false,
      error: "Draft generation requires ANTHROPIC_API_KEY — synthesis disabled on server.",
      fallback: "Compose finalization files manually.",
    };
  }

  // 1. Fetch all living documents
  const docMap = await fetchFiles(projectSlug, [...LIVING_DOCUMENTS]);

  // 2. Collect commit history for this session
  const sessionCommits: string[] = [];
  try {
    const commits = await listCommits(projectSlug, { per_page: 50 });
    for (const commit of commits) {
      if (commit.message.startsWith("prism: finalize session")) break;
      sessionCommits.push(commit.message);
    }
  } catch {
    // Non-critical — drafts will be less informed but still useful
  }

  // 3. Build prompt and call Opus 4.6
  const userMessage = buildFinalizationDraftMessage(
    projectSlug,
    sessionNumber,
    docMap,
    sessionCommits
  );

  logger.info("Finalization draft: calling Opus", {
    projectSlug,
    sessionNumber,
    docCount: docMap.size,
    commitCount: sessionCommits.length,
  });

  const result = await synthesize(FINALIZATION_DRAFT_PROMPT, userMessage, 4096);

  if (!result) {
    return {
      success: false,
      error: "Opus API call failed or returned null.",
      fallback: "Compose finalization files manually.",
    };
  }

  // 4. Parse response — expect JSON
  try {
    const clean = result.content.replace(/```json\n?|```\n?/g, "").trim();
    const drafts = JSON.parse(clean);

    return {
      success: true,
      drafts,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      review_instructions: "Review each draft section. Edit as needed, then include in your commit files. These are drafts — you have full editorial control.",
    };
  } catch {
    return {
      success: true,
      raw_content: result.content,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      parse_warning: "Could not parse structured JSON — raw content included for manual extraction.",
    };
  }
}
```

**Change 6c:** Update the tool registration to support the "draft" action. In the `registerFinalize` function, make these changes:

1. Update the action enum from `z.enum(["audit", "commit"])` to `z.enum(["audit", "draft", "commit"])`

2. Update the action description from `"Finalization phase"` to `"Finalization phase: 'audit' for document inventory, 'draft' for AI-generated file drafts, 'commit' to push final files"`

3. In the tool's async handler, add a `draft` branch. Find the block:

```typescript
if (action === "audit") {
  // ... audit logic ...
}

// Commit phase
```

Change it to:

```typescript
if (action === "audit") {
  // ... existing audit logic stays unchanged ...
}

if (action === "draft") {
  const result = await draftPhase(project_slug, session_number);
  logger.info("prism_finalize draft complete", {
    project_slug,
    success: result.success,
    ms: Date.now() - start,
  });
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
  };
}

// Commit phase
```

---

### 7. MODIFY: src/tools/bootstrap.ts

Enhance prefetching to also use handoff next_steps as keyword sources (not just opening_message).

Find the section that computes prefetch (around line ~200, the block starting with `if (opening_message)`):

```typescript
if (opening_message) {
  const prefetchPaths = determinePrefetchFiles(opening_message);
  if (prefetchPaths.length > 0) {
    prefetchPromise = fetchFiles(resolvedSlug, prefetchPaths).then(results => {
```

Replace with:

```typescript
// Enhanced prefetching: combine opening message keywords + next steps from handoff
const prefetchSet = new Set<string>();

if (opening_message) {
  for (const f of determinePrefetchFiles(opening_message)) {
    prefetchSet.add(f);
  }
}

// Also pre-fetch based on next steps content (always available from handoff)
if (nextSteps.length > 0) {
  for (const f of determinePrefetchFiles(nextSteps.join(" "))) {
    prefetchSet.add(f);
  }
}

const prefetchPaths = Array.from(prefetchSet);

if (prefetchPaths.length > 0) {
  prefetchPromise = fetchFiles(resolvedSlug, prefetchPaths).then(results => {
```

The rest of the prefetch block (the `.then()` callback and beyond) stays unchanged.

---

## Verification

1. **Build check:** Run `npm run build` — should compile with zero errors
2. **Tool count:** Server should now register 12 tools total: bootstrap, fetch, push, status, finalize, analytics, scale_handoff, search, synthesize, log_decision, log_insight, patch
3. **Health check:** `curl https://prism-mcp-server-production.up.railway.app/health` → version should remain 2.8.0 (or bump to 2.9.0 if you choose to update SERVER_VERSION in config.ts — recommended)
4. **Smoke test each new tool** (in a new conversation after connector reconnect):
   - `prism_log_decision` with a test decision on a test project
   - `prism_log_insight` with a test insight
   - `prism_patch` with a section append on task-queue.md
   - `prism_finalize` with action `"draft"` 

## Post-Flight

1. **Recommended:** Update `SERVER_VERSION` in `src/config.ts` from `"2.8.0"` to `"2.9.0"`
2. Railway auto-deploys on push to main
3. **Wait for Railway deploy to complete** before reconnecting (INS-10)
4. Disconnect and reconnect PRISMv2 MCP Server connector in Claude.ai Settings
5. Start a **new conversation** to pick up the 12-tool manifest (INS-11)
6. Run smoke tests in the new conversation

<!-- EOF: s23-efficiency-tools.md -->
