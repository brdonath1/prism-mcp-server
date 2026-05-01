# Brief 412 — Active model awareness + queue triage rule

**Status:** PENDING (Trigger daemon will pick up automatically)
**Repo:** prism-framework (cross-repo single-file edit)
**Origin:** PRISM session S108 (2026-05-01), implements D-193 Piece 2 on `brdonath1/prism`

## Context

D-193 (logged S108, optimization domain) settled a four-piece integrated solution:

- **Piece 1** — Persisted recommendation in handoff.md. **SHIPPED** in brief-411 (server v4.2.0, deployed 2026-05-01).
- **Piece 2** — Active model awareness + queue triage. **THIS BRIEF.**
- **Piece 3** — Per-task tagging. Future brief.
- **Piece 4** — Concise-by-default rule. **SHIPPED** in core-template-mcp.md v2.16.0 (deployed 2026-05-01).

Piece 1 ensures the *recommendation* is consistent across the session boundary (finalize banner ↔ boot banner). Piece 2 closes the loop by giving Claude active awareness of the model + thinking setting actually loaded for the current session — independent of what was recommended — so it can adapt task sequencing accordingly. The operator may have accepted the recommendation, overridden it, or opened the session without seeing the banner; Piece 2 makes that selection visible and actionable to Claude.

The behavioral contract is:
- Match (actual = recommended) → proceed normally.
- Actual weaker than recommended → sequence mechanical work first; flag reasoning-heavy items with "this would benefit from {recommended.display} — defer or proceed?"; honor operator's call.
- Actual stronger than recommended → brief one-line note that lighter work could have run on a smaller model (token-efficiency reminder); proceed without friction.

This is a **pure framework-template change**. No `prism-mcp-server` code changes. No new MCP tool. The new tool surface required is conversational (Claude self-reports model + thinking on turn 1; holds the values in conversation context; uses them for triage from there).

## Required Changes

### Single edit: `brdonath1/prism-framework:_templates/core-template-mcp.md`

#### Change 1 — Version bump (top of file)

Replace the heading line:

```
# PRISM Core Template v2.16.0 (MCP Mode)
```

with:

```
# PRISM Core Template v2.17.0 (MCP Mode)
```

And the metadata line below the blockquote:

```
> **Template Version:** 2.16.0
```

with:

```
> **Template Version:** 2.17.0
```

#### Change 2 — Add a new Tier A standing rule under `## Operating Posture`

**Insertion point:** Inside the `## Operating Posture` section, immediately after the existing `**Concise by default.**` bullet (the last bullet in the list as of v2.16.0), append a new bullet. The full bullet text (verbatim, including the bold lead-in):

```markdown
- **Active model awareness.** On the first response after `prism_bootstrap` returns (i.e., the boot response itself), include a self-report of the current model and thinking setting in the form: `Running: {Model display} · {Adaptive on | Adaptive off | Adaptive unknown}`. Place this line as the first plain-prose line of Block 4 (the opening statement) — not inside the banner code fence. Identify the model from system-prompt context; report `Adaptive unknown` when the thinking state is not verifiable from context (the operator can confirm via follow-up). Hold the self-reported values in conversation context for the remainder of the session — they do not need to be re-derived per turn.

  Then compare actual against `recommended_session_settings` (the persisted block from handoff.md, surfaced via the boot banner's `Suggested:` line). Three branches drive task triage during the session:

  1. **Match** (actual model = recommended model AND actual thinking = recommended thinking, or recommendation is null/absent) — Proceed normally. No triage commentary required.

  2. **Actual weaker than recommended** — Inspect the work queue (`Next Steps` in handoff, plus user requests as they arrive). Sequence mechanical/executional items first. For any item that is materially reasoning-heavy or judgment-heavy, surface the tradeoff to the operator before starting it: `"This item would benefit from {recommended.display} (the pre-boot recommendation). Current session is on {actual.display}. Defer to a future session, or proceed on the current model?"`. Honor the operator's choice without further friction. Do NOT inject this prompt for each individual item if the operator has already given a blanket directive ("just do everything on the current model").

  3. **Actual stronger than recommended** — Mention once, near the start of substantive work: `"Note: this session is on {actual.display}; the pre-boot recommendation was {recommended.display}. Lighter work in the queue could have run on a smaller model — flagging for awareness only; proceeding."` No further commentary; do not repeat per-item.

  **Model strength ordering** (for "weaker"/"stronger" determinations): Opus 4.7 > Opus 4.6 > Sonnet 4.6 > Haiku 4.5. Within the same model, Adaptive on > Adaptive off. When the recommendation references a model not in this ordering (future model strings), default to "match" semantics and skip triage rather than guessing.

  **Operator override always wins.** This rule produces *advisory friction* on misalignment — it never blocks work. If the operator says "proceed anyway", "do it on this model", or similar, the triage prompt is satisfied for that item and the rule does not re-fire on the same item.
```

#### Change 3 — No other edits

Do NOT modify any other section of the template. Do NOT alter Rule 2's Boot Response Template structure (Blocks 1-5). The new self-report line goes inside Block 4 per Change 2; it does not require a new Block.

## Verification Steps

1. After commit lands on `prism-framework:main`: server template cache TTL is 5 minutes; next session boot after the cache expires picks up v2.17.0 automatically.
2. S109 boot is the verification gate. Expected behaviors:
   - Boot response Block 4 begins with `Running: {Model} · {Adaptive on/off/unknown}` as the first plain-prose line.
   - Banner code fence's `Suggested:` line still rendered (unchanged from v2.16.0).
   - If `Running:` matches `Suggested:`, no triage commentary.
   - If they differ, triage logic per Change 2 fires the first time a reasoning-heavy item is queued.
3. Operator verifies subjectively that the self-report is accurate and that triage prompts arrive at the right moments (not on every turn, not silently swallowed).

## Out of Scope

- D-193 Piece 3 (per-task tagging) — separate brief.
- Any change to `recommended_session_settings` shape, classifier keyword lists, or persisted-block format.
- Server-side state for `current_session_actual` — explicitly NOT implemented per S108 design discussion (conversation-context-only is sufficient and avoids unnecessary server complexity).
- New MCP tools. None required.

## Failure Modes to Avoid

- Do NOT add the `Running:` line inside the banner code fence (Block 3). It belongs in Block 4 as plain prose.
- Do NOT block work when actual differs from recommended. The rule produces advisory friction, never a hard stop.
- Do NOT re-prompt on the same task after the operator has answered. One prompt per item, then proceed per their answer.
- Do NOT treat a missing/null `recommended_session_settings` as a reason to demand operator confirmation. Treat it as a "match" branch and proceed silently.
- Do NOT modify the FORBIDDEN list in Rule 2 to forbid the `Running:` line — that list is for unwanted decoration, the `Running:` line is required content.

<!-- EOF: brief-412-active-model-awareness.md -->
