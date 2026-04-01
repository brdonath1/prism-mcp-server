# Brief 030: PRISM Intelligence Layer — Track 1 + Track 2

> **Priority:** HIGH
> **Branch:** main
> **Session:** S22
> **Design doc:** `docs/intelligence-layer-design.md` (in this repo)

---

## Pre-Work: GitHub Sync

```bash
cd ~/prism-mcp-server && git pull origin main
```

Read `docs/intelligence-layer-design.md` for full architectural context before starting.

---

## Objective

Add an AI-powered intelligence synthesis layer to the PRISM MCP server. Two tracks:

**Track 1 (no API dependency):** Extract "STANDING RULE" entries from insights.md at bootstrap and include them in the response. This ensures operational procedures survive session boundaries.

**Track 2 (Anthropic API integration):** After finalization commit, call Opus 4.6 with ALL living documents to synthesize an `intelligence-brief.md`. This brief is automatically loaded at the next bootstrap, providing deep operational context that the handoff alone cannot carry.

---

## Changes

### 1. Install dependency

```bash
npm install @anthropic-ai/sdk
```

### 2. `src/config.ts` — Add synthesis configuration

Add these exports after the existing config:

```typescript
/** Anthropic API key for Opus 4.6 synthesis (Track 2) */
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";

/** Model to use for synthesis */
export const SYNTHESIS_MODEL = process.env.SYNTHESIS_MODEL ?? "claude-opus-4-6";

/** Whether synthesis is enabled (requires API key) */
export const SYNTHESIS_ENABLED = !!process.env.ANTHROPIC_API_KEY;

/** Max output tokens for synthesis calls */
export const SYNTHESIS_MAX_OUTPUT_TOKENS = 4096;
```

Update `LIVING_DOCUMENTS` array — add `"intelligence-brief.md"` as the 10th entry. Update the comment to say `(D-18, D-41, D-44)`.

### 3. Create `src/ai/client.ts` — Anthropic API client

```typescript
/**
 * Thin Anthropic API client for PRISM synthesis operations.
 * Graceful degradation: returns null on any failure.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, SYNTHESIS_MODEL, SYNTHESIS_MAX_OUTPUT_TOKENS } from "../config.js";
import { logger } from "../utils/logger.js";

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (!ANTHROPIC_API_KEY) {
    return null;
  }
  if (!client) {
    client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return client;
}

export interface SynthesisResult {
  content: string;
  input_tokens: number;
  output_tokens: number;
  model: string;
}

/**
 * Call Opus 4.6 for synthesis. Returns null on any failure.
 */
export async function synthesize(
  systemPrompt: string,
  userContent: string,
  maxTokens?: number
): Promise<SynthesisResult | null> {
  const anthropic = getClient();
  if (!anthropic) {
    logger.info("Synthesis skipped — ANTHROPIC_API_KEY not configured");
    return null;
  }

  const start = Date.now();
  try {
    const response = await anthropic.messages.create({
      model: SYNTHESIS_MODEL,
      max_tokens: maxTokens ?? SYNTHESIS_MAX_OUTPUT_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });

    const textContent = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    const result: SynthesisResult = {
      content: textContent,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      model: SYNTHESIS_MODEL,
    };

    logger.info("Synthesis API call complete", {
      model: SYNTHESIS_MODEL,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      ms: Date.now() - start,
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Synthesis API call failed", { error: message, ms: Date.now() - start });
    return null;
  }
}
```

### 4. Create `src/ai/prompts.ts` — Synthesis prompts

```typescript
/**
 * System prompts for PRISM intelligence synthesis operations.
 */

export const FINALIZATION_SYNTHESIS_PROMPT = `You are the PRISM Intelligence Synthesis Engine. Your purpose is to read ALL of a project's living documents and produce a dense, high-quality intelligence brief that will orient the next AI assistant session.

You are solving a critical problem: AI assistants lose operational intelligence at session boundaries. They know WHAT to do but forget HOW to do it — specific workflows, standing procedures, user preferences, active gotchas, and the narrative thread connecting recent sessions.

Produce a markdown document with EXACTLY these 6 sections:

## Project State
Dense summary of what this project IS and where it stands RIGHT NOW. More contextual than a handoff — include the "feel" of the project's current momentum. What just happened in the latest session? What's the immediate trajectory?

## Standing Rules & Workflows
Extract ALL entries from insights.md that are tagged as "STANDING RULE" or "Standing Operating Procedure" — reproduce their key steps EXACTLY, not summarized. Also identify any implicit operational workflows from the session log that are repeated across 3+ sessions but haven't been formally documented. These are the procedures the next session MUST follow.

## Active Operational Knowledge
Patterns, user preferences, and working conventions that are relevant RIGHT NOW. Include: preferred tools and approaches, communication style preferences, naming conventions, technical patterns that have been established. Skip historical knowledge that no longer applies.

## Recent Trajectory
A connected NARRATIVE (not bullet points) of what happened over the last 3-5 sessions. Show the momentum — what threads are being pulled, what problems are being solved, what direction things are moving. The next assistant should feel like they're catching up from a colleague, not reading a changelog.

## Risk Flags
Concrete, specific things the next session must be careful about. For each flag:
- What the risk is (specific: "KI-49 means discovery sessions save transcripts but do NOT trigger persona generation")
- Why it matters (impact if ignored)
- What to do about it (action or avoidance)

## Quality Audit
Honest assessment of documentation quality. Flag:
- Topics discussed in recent sessions that were NOT captured in any living document
- Living documents that appear stale or contradictory
- Gaps between what the task queue says and what was actually accomplished
- Any standing rules or workflows that exist in practice but aren't documented

FORMATTING RULES:
- Output valid markdown. Start with the H1 title and metadata block shown below.
- Be DENSE. Every sentence must carry information. No filler.
- Standing rules must include exact steps — do not summarize procedures.
- Risk flags must be concrete and actionable — no vague warnings.
- Total output: 2000-4000 tokens. If you need more, you're not being dense enough.
- End with the EOF sentinel: <!-- EOF: intelligence-brief.md -->

OUTPUT FORMAT — start your response with exactly this:
# Intelligence Brief — {PROJECT_NAME}

> AI-synthesized session intelligence. Generated by Opus 4.6 at finalization.
> Last synthesized: S{SESSION_NUMBER} ({TIMESTAMP})

Then the 6 sections above.`;

/**
 * Build the user message for finalization synthesis.
 * Concatenates all living documents with clear file headers.
 */
export function buildSynthesisUserMessage(
  projectSlug: string,
  sessionNumber: number,
  timestamp: string,
  documents: Map<string, { content: string; size: number }>
): string {
  const parts: string[] = [
    \`Project: \${projectSlug}\`,
    \`Session just completed: S\${sessionNumber}\`,
    \`Timestamp: \${timestamp}\`,
    \`\\n---\\nLIVING DOCUMENTS (read all of these):\\n\`,
  ];

  for (const [path, doc] of documents) {
    parts.push(\`\\n### FILE: \${path} (\${doc.size} bytes)\\n\`);
    parts.push(doc.content);
    parts.push(\`\\n--- END \${path} ---\\n\`);
  }

  return parts.join("\\n");
}
```

### 5. Create `src/ai/synthesize.ts` — Synthesis pipeline

```typescript
/**
 * Intelligence synthesis pipeline.
 * Loads all living documents, calls Opus 4.6, pushes intelligence-brief.md.
 */

import { fetchFiles, pushFile } from "../github/client.js";
import { LIVING_DOCUMENTS, SYNTHESIS_ENABLED } from "../config.js";
import { logger } from "../utils/logger.js";
import { synthesize } from "./client.js";
import { FINALIZATION_SYNTHESIS_PROMPT, buildSynthesisUserMessage } from "./prompts.js";
import { generateCstTimestamp } from "../utils/banner.js";

export interface SynthesisOutcome {
  success: boolean;
  bytes_written?: number;
  input_tokens?: number;
  output_tokens?: number;
  error?: string;
}

/**
 * Generate an intelligence brief for a project.
 * Loads all living documents, synthesizes via Opus 4.6, pushes result.
 */
export async function generateIntelligenceBrief(
  projectSlug: string,
  sessionNumber: number
): Promise<SynthesisOutcome> {
  if (!SYNTHESIS_ENABLED) {
    return { success: false, error: "Synthesis disabled — no API key" };
  }

  const start = Date.now();

  try {
    // 1. Fetch ALL living documents (exclude intelligence-brief.md itself to avoid circular reference)
    const docsToFetch = LIVING_DOCUMENTS.filter(d => d !== "intelligence-brief.md");
    const docMap = await fetchFiles(projectSlug, docsToFetch);

    // Also fetch decision domain files if they exist
    const decisionDomains = [
      "decisions/architecture.md",
      "decisions/operations.md",
      "decisions/optimization.md",
      "decisions/onboarding.md",
      "decisions/integrity.md",
      "decisions/resilience.md",
      "decisions/production-stack.md",
    ];

    let domainMap: Map<string, { content: string; size: number }> = new Map();
    try {
      domainMap = await fetchFiles(projectSlug, decisionDomains);
    } catch {
      // Domain files may not all exist — that's fine
      logger.info("Some decision domain files not found", { projectSlug });
    }

    // Merge all documents
    const allDocs = new Map([...docMap, ...domainMap]);

    // 2. Build the user message
    const timestamp = generateCstTimestamp();
    const userMessage = buildSynthesisUserMessage(projectSlug, sessionNumber, timestamp, allDocs);

    logger.info("Synthesis input assembled", {
      projectSlug,
      sessionNumber,
      documentCount: allDocs.size,
      totalBytes: Array.from(allDocs.values()).reduce((sum, d) => sum + d.size, 0),
    });

    // 3. Call Opus 4.6
    const result = await synthesize(FINALIZATION_SYNTHESIS_PROMPT, userMessage);

    if (!result) {
      return { success: false, error: "Synthesis API returned null" };
    }

    // 4. Validate the response has required sections
    const requiredSections = [
      "## Project State",
      "## Standing Rules & Workflows",
      "## Active Operational Knowledge",
      "## Recent Trajectory",
      "## Risk Flags",
      "## Quality Audit",
    ];

    const missingSections = requiredSections.filter(s => !result.content.includes(s));
    if (missingSections.length > 0) {
      logger.warn("Synthesis output missing sections", { missingSections });
      // Still push — partial brief is better than no brief
    }

    // 5. Ensure EOF sentinel
    let content = result.content.trim();
    if (!content.endsWith("<!-- EOF: intelligence-brief.md -->")) {
      content += "\n\n<!-- EOF: intelligence-brief.md -->\n";
    }

    // 6. Push to project repo
    const pushResult = await pushFile(
      projectSlug,
      "intelligence-brief.md",
      content,
      `prism: S${sessionNumber} intelligence brief (auto-synthesized)`
    );

    const outcome: SynthesisOutcome = {
      success: true,
      bytes_written: new TextEncoder().encode(content).length,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
    };

    logger.info("Intelligence brief generated and pushed", {
      projectSlug,
      sessionNumber,
      ...outcome,
      ms: Date.now() - start,
    });

    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Intelligence brief generation failed", {
      projectSlug,
      sessionNumber,
      error: message,
      ms: Date.now() - start,
    });
    return { success: false, error: message };
  }
}
```

### 6. Create `src/tools/synthesize.ts` — New MCP tool

```typescript
/**
 * prism_synthesize tool — On-demand intelligence brief generation.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SYNTHESIS_ENABLED } from "../config.js";
import { fetchFile } from "../github/client.js";
import { generateIntelligenceBrief } from "../ai/synthesize.js";
import { logger } from "../utils/logger.js";

export function registerSynthesize(server: McpServer) {
  server.tool(
    "prism_synthesize",
    "Generate or check an AI-synthesized intelligence brief for a project. Use mode 'generate' to create/refresh the brief. Use mode 'status' to check if one exists.",
    {
      project_slug: z.string().describe("Project repo name"),
      mode: z.enum(["generate", "status"]).describe("'generate' to create/refresh, 'status' to check"),
      session_number: z.number().optional().describe("Session number (required for generate)"),
    },
    async ({ project_slug, mode, session_number }) => {
      const start = Date.now();
      logger.info("prism_synthesize", { project_slug, mode });

      try {
        if (mode === "status") {
          try {
            const file = await fetchFile(project_slug, "intelligence-brief.md");
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  exists: true,
                  size_bytes: file.size,
                  synthesis_enabled: SYNTHESIS_ENABLED,
                  // Extract the "Last synthesized" line
                  last_synthesized: file.content.match(/Last synthesized: (S\d+ \([^)]+\))/)?.[1] ?? "unknown",
                }),
              }],
            };
          } catch {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  exists: false,
                  synthesis_enabled: SYNTHESIS_ENABLED,
                  message: SYNTHESIS_ENABLED
                    ? "No intelligence brief exists yet. Run mode:'generate' after a finalization."
                    : "Synthesis disabled — ANTHROPIC_API_KEY not configured on server.",
                }),
              }],
            };
          }
        }

        // Generate mode
        if (!session_number) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: "session_number is required for generate mode" }),
            }],
            isError: true,
          };
        }

        if (!SYNTHESIS_ENABLED) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "Synthesis disabled — ANTHROPIC_API_KEY not configured on server.",
              }),
            }],
            isError: true,
          };
        }

        const result = await generateIntelligenceBrief(project_slug, session_number);

        logger.info("prism_synthesize complete", {
          project_slug,
          mode,
          success: result.success,
          ms: Date.now() - start,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("prism_synthesize failed", { project_slug, mode, error: message });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    }
  );
}
```

### 7. Modify `src/tools/bootstrap.ts` — Add standing rules + intelligence brief

**A. Add standing rules extraction function** (add before the `registerBootstrap` export):

```typescript
interface StandingRule {
  id: string;
  title: string;
  content: string;
}

/**
 * Extract STANDING RULE entries from insights.md content.
 */
function extractStandingRules(insightsContent: string | null): StandingRule[] {
  if (!insightsContent) return [];

  const rules: StandingRule[] = [];
  // Split by ### headers
  const sections = insightsContent.split(/(?=^### )/m);

  for (const section of sections) {
    // Check if this section contains "STANDING RULE" (case-insensitive)
    if (/standing\s+rule/i.test(section)) {
      const headerMatch = section.match(/^### (INS-\d+):?\s*(.+)/);
      if (headerMatch) {
        rules.push({
          id: headerMatch[1],
          title: headerMatch[2].trim(),
          content: section.trim(),
        });
      }
    }
  }

  return rules;
}
```

**B. In the main bootstrap flow**, after existing prefetch logic, add:

1. Fetch insights.md (if not already prefetched) and extract standing rules
2. Fetch intelligence-brief.md and include in response

Add to the response object:
```typescript
standing_rules: standingRules,
intelligence_brief: intelligenceBriefContent,  // string | null
```

### 8. Modify `src/tools/finalize.ts` — Add post-commit synthesis trigger

In the commit phase, after all files are successfully pushed and verified, add:

```typescript
import { SYNTHESIS_ENABLED } from "../config.js";
import { generateIntelligenceBrief } from "../ai/synthesize.js";

// After successful commit, fire-and-forget synthesis:
if (SYNTHESIS_ENABLED) {
  generateIntelligenceBrief(project_slug, session_number)
    .then(synthResult => {
      logger.info("Post-finalization synthesis complete", {
        project_slug, session_number,
        success: synthResult.success,
        tokens: synthResult.input_tokens,
      });
    })
    .catch(err => {
      logger.error("Post-finalization synthesis failed", {
        project_slug,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}
```

Add `synthesis_triggered: SYNTHESIS_ENABLED` to the commit phase response object.

### 9. Modify `src/index.ts` — Register new tool

Add import:
```typescript
import { registerSynthesize } from "./tools/synthesize.js";
```

Add in `createServer()`:
```typescript
registerSynthesize(server);
```

### 10. Update `src/config.ts` — SERVER_VERSION

Bump to `"2.8.0"`.

---

## What NOT to Change

- Do NOT modify the audit phase of finalize — it should continue to work exactly as today
- Do NOT modify the banner rendering logic
- Do NOT change the existing prefetch keyword system — standing rules are additive
- Do NOT make synthesis blocking — it must be fire-and-forget after commit
- Do NOT remove or rename any existing living documents
- Do NOT change the existing MCP tool schemas (only add new fields to responses)

---

## Verification

1. `npm run build` — TypeScript compiles with no errors
2. `npm test` — All existing tests pass
3. **Track 1 test:** Create a test insights.md with a STANDING RULE entry, verify `extractStandingRules()` returns it correctly
4. **Track 2 test:** With ANTHROPIC_API_KEY set, verify `generateIntelligenceBrief()` produces valid markdown with all 6 required sections
5. **Graceful degradation test:** Without ANTHROPIC_API_KEY, verify bootstrap and finalize work exactly as before (no errors, no synthesis)
6. **New tool test:** Verify `prism_synthesize` with mode "status" and mode "generate"
7. Server starts cleanly: `npm start`

Write tests in `tests/` following existing patterns (vitest).

---

## Post-Work: GitHub Sync + Merge

```bash
git add -A && git commit -m "prism: D-44 intelligence layer — Track 1 standing rules + Track 2 Opus synthesis (S22)" && git push origin main
```

Verify Railway auto-deploys successfully. Check `/health` endpoint.

After deploy, user must add `ANTHROPIC_API_KEY` to Railway environment variables for Track 2 to activate.
