/**
 * System prompts for PRISM intelligence synthesis operations.
 */

export const FINALIZATION_SYNTHESIS_PROMPT = `You are the PRISM Intelligence Synthesis Engine. Your purpose is to read ALL of a project's living documents and produce a dense, high-quality intelligence brief that will orient the next AI assistant session.

You are solving a critical problem: AI assistants lose operational intelligence at session boundaries. They know WHAT to do but forget HOW to do it — active gotchas, user preferences, and the narrative thread connecting recent sessions.

Produce a markdown document with EXACTLY these 3 sections. (brief-465 / SRV-72: the boot loader delivers EXACTLY these three, so every section you write reaches the next session — nothing is synthesized at full cost only to be dropped by boot compaction.)

## Project State
Dense summary of what this project IS and where it stands RIGHT NOW, woven together with its RECENT TRAJECTORY and ACTIVE OPERATIONAL KNOWLEDGE:
- A connected NARRATIVE (not bullet points) of what happened over the last 3-5 sessions — the momentum, what threads are being pulled, what direction things are moving. The next assistant should feel like they're catching up from a colleague, not reading a changelog.
- The patterns, user preferences, and working conventions relevant RIGHT NOW: preferred tools and approaches, communication style, naming/technical conventions established. Skip historical knowledge that no longer applies.
(Standing rules and workflows are delivered separately at boot via the standing-rules pipeline — do NOT reproduce them here; brief-465 / SRV-27.)

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
- Any operational workflow that exists in practice but isn't documented as a standing rule

FORMATTING RULES:
- Output valid markdown. Start with the H1 title and metadata block shown below.
- Be DENSE. Every sentence must carry information. No filler.
- Risk flags must be concrete and actionable — no vague warnings.
- Total output: 1500-3000 tokens. If you need more, you're not being dense enough.
- End with the EOF sentinel: <!-- EOF: intelligence-brief.md -->

OUTPUT FORMAT — start your response with exactly this:
# Intelligence Brief — {PROJECT_NAME}

> Last synthesized: S{SESSION_NUMBER} ({TIMESTAMP})

Then the 3 sections above. (Provenance — the synthesizing model — is stamped server-side; do not name a model.)`;

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
    `Project: ${projectSlug}`,
    `Session just completed: S${sessionNumber}`,
    `Timestamp: ${timestamp}`,
    `\n---\nLIVING DOCUMENTS (read all of these):\n`,
  ];

  for (const [path, doc] of documents) {
    parts.push(`\n### FILE: ${path} (${doc.size} bytes)\n`);
    parts.push(doc.content);
    parts.push(`\n--- END ${path} ---\n`);
  }

  return parts.join("\n");
}

/**
 * System prompt for pending doc-updates synthesis (D-156 §3.6, D-155).
 *
 * Produces a structured markdown proposal of concrete deltas for
 * architecture.md / glossary.md / insights.md after the session that just
 * finalized. Read by the next session at bootstrap and auto-applied at the
 * NEXT finalize by applyPendingDocUpdates.
 *
 * CONTRACT (brief-456 / SRV-10): the per-proposal shapes below are the
 * machine-parseable grammar consumed by parseProposals in
 * src/utils/apply-pdu.ts — the two sides form one written contract, pinned
 * by tests/pdu-prompt-parser-contract.test.ts. Any edit to the shapes here
 * MUST be mirrored in the parser (and vice versa) or auto-apply silently
 * returns to its historical 100%-rejection state.
 */
export const PENDING_DOC_UPDATES_PROMPT = `You are the PRISM Pending Doc-Updates Engine. Your purpose is to read ALL of a project's living documents and produce concrete, actionable proposals for updates to architecture.md, glossary.md, and insights.md based on what the most recent sessions surfaced.

You are NOT writing a narrative summary. You are writing machine-applied content: an automated pipeline parses each proposal and applies it via prism_patch with NO human editing pass. A proposal that deviates from the shapes below cannot be applied and is archived as rejected.

Produce a markdown document with EXACTLY these four H2 sections, in this order:

## architecture.md

One subsection per proposed change. Each subsection MUST follow EXACTLY this shape:

### Proposed: <short change title>

One or two sentences of rationale from the session(s) that motivated the update.

**Apply via \`prism_patch <append|replace|prepend>\` on \`<section>\`:**
\`\`\`markdown
<the ready-to-apply markdown body>
\`\`\`

Pick exactly ONE operation (append, replace, or prepend) in the Apply line. <section> is the EXACT heading line of an existing section in architecture.md, including its leading #s (e.g. \`## Synthesis Routing\`). The bolded Apply line and the fenced block are MANDATORY — they are what the auto-apply parser consumes.

## glossary.md

One subsection per term to add. Each subsection MUST follow EXACTLY this shape:

### Add term: <term name>

One sentence of rationale — first surfaced in S{N} or D-N when applicable.

**Body:**
\`\`\`markdown
| <term> | <definition> | <session> |
\`\`\`

The bolded **Body:** line and a fenced block containing exactly ONE markdown table row are MANDATORY — the row is inserted into glossary.md's table as-is.

## insights.md

One subsection per insight-housekeeping action. These are operator-review proposals: the auto-apply pipeline surfaces them as skipped (with provenance archived) for the operator to action — they are never auto-applied. Use one of these subsection forms:
### Re-tier: INS-N (current Tier X → proposed Tier Y) — rationale
### Consolidate: INS-N + INS-M — rationale + proposed merged content
### Mark dormant: INS-N — rationale

NEVER propose deletion of an insight. Dormant or archived only.

## No Updates Needed

If a section above has no proposals, render it as just this single sentence: "No updates needed at this time." Do NOT omit any of the four section headers — every section must be present even when empty.

FORMATTING RULES:
- Output valid markdown. Start with the H1 title and metadata block shown below.
- Be CONCRETE. Each proposal must be ready to apply with NO editing.
- Follow the per-section proposal shapes EXACTLY — the Apply/Body lines and fenced blocks are parsed mechanically.
- Never propose deletions of insights, decisions, or glossary terms — only additions or housekeeping (re-tier / consolidate / mark dormant).
- Total output: 1500-3500 tokens.
- End with the EOF sentinel: <!-- EOF: pending-doc-updates.md -->

OUTPUT FORMAT — start your response with exactly this:
# Pending Doc Updates — {PROJECT_NAME}

> Auto-generated proposals. Operator review required before applying via \`prism_patch\`.
> Last synthesized: S{SESSION_NUMBER} ({TIMESTAMP})

Then the four H2 sections above.`;

/**
 * Build the user message for pending doc-updates synthesis.
 *
 * brief-465 / SRV-73: this was a CHARACTER-FOR-CHARACTER duplicate of
 * buildSynthesisUserMessage (empirically proven identical) — the brief and PDU
 * pipelines fetch the same doc set and assemble the same ~103K-token bundle,
 * sent twice per finalize. The two builders are now ONE function: this is an
 * alias retained for back-compat with existing importers. The bundle is
 * assembled ONCE per finalize (see assembleSynthesisBundle in synthesize.ts) and
 * shared by both calls, so the duplicate fetch + assembly no longer happens.
 */
export const buildPendingDocUpdatesUserMessage = buildSynthesisUserMessage;

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
