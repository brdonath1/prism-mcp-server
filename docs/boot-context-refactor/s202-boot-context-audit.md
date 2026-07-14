# S202 Boot-Context Burn Audit (Tasks A + B) — brief-s202a

**Purpose:** exhaustive READ-ONLY inventory of everything that enters a PRISM chat session's
context window (boot + per-protocol during the session), with measured bytes and estimated
tokens, plus a per-component value/redundancy analysis. Companion machine-readable inventory:
`s202-component-inventory.json`. Refactor design: `s202-refactor-proposals.md`.

**Repos read (INS-283 — `git fetch` + `git show origin/main:<path>` only; working trees untouched):**

| Repo | origin/main HEAD at audit |
|---|---|
| `brdonath1/prism-mcp-server` | `79a4ff43dec4d43611a959f5553f94574122bed0` |
| `brdonath1/prism` (worked example) | `0801b36a92107edd64dc601042a7c11612336ea5` |
| `brdonath1/prism-framework` | `4aaade1f5410197cb90268e25a3c8f4e718c5d3d` |

**Method (INS-40 / INS-304 — measured, not asserted):** the prism-project bootstrap payload was
reconstructed offline by feeding the origin/main snapshots of the prism living documents and the
framework template through the server's **own compiled code** (`dist/` build of this repo at
`79a4ff4`: `compactIntelligenceBrief`, `unionStandingRules`, `selectStandingRulesForBoot`,
`summarizeMarkdown`, `renderUnifiedBanner`, `renderBootMastheadSvg`,
`buildAutonomousWorkLoopPayload`, `getExpectedToolSurface`, `computePayloadAttribution`, the
handoff parsers), mirroring the result assembly at `src/tools/bootstrap.ts:1358-1400` and the
measurement block at `src/tools/bootstrap.ts:1419-1465`. This is the same reconstruction method
the S167 server audit used (`.prism/audits/s167-server-audit.md:683-705`, 5-byte agreement then).

**Reconstruction accuracy:** reconstructed `bootstrap_tokens` = **33,879** vs the live S202
measurement **33,868** — an **11-token (0.03%) agreement**, so the per-field attribution below is
treated as measured. (Residual variance: live `warnings`, `trigger_enrollment`, `files_fetched`,
and the timestamp differ slightly from the simulated values; the S202-scenario prefetch set is
labeled in the JSON.)

**Conventions:** est tokens = bytes / 3.5 (the codebase-standard proxy, `src/config.ts:225-237`);
bytes are serialized-JSON delivered bytes per field (`src/utils/payload-attribution.ts:32-50`),
not source-file sizes, unless marked "source". The live window divisor is 200K: the percentage in
the pinned S202 evidence (41,368 tokens = 20.7%) arithmetically implies a 200,000-token divisor,
which matches the documented production env override (brief-449 Change 4.5: "the Railway env
override (D-253 sets 200000 in production)") — the code default is 500K (`src/config.ts:69-70`).
No env value was read for this audit.

---

## §1 The five context-entry phases

A PRISM chat session's context is filled through five distinct phases. Only phase 2 is what
`context_estimate` measures; the operator experiences the sum.

1. **Platform load (session start, before any tool call):** Claude.ai system prompt, Project
   Instructions (framework template `_templates/project-instructions.md` is 3,521 B ≈ ~1,006 tok),
   and the MCP connector's initially-loaded tool subset. The server models this as a flat
   `platform_overhead_tokens: 5000` (`src/tools/bootstrap.ts:1444`). *Assumption: actual platform
   overhead is not measurable server-side; 5K is plausible for system prompt + Project
   Instructions + partial tool defs but carries no error bars.*
2. **`prism_bootstrap` response (the dominant single item):** 119,662 B ≈ **34.2K tok** wire
   (§2.1) — measured 33,868 tok live at the tripwire point.
3. **Post-boot protocol turns (template-mandated, before the opening response):**
   three `tool_search` calls (`core-template-mcp.md:106-111`, queries from
   `src/tool-registry.ts:117-125`), the Codex sidecar `prism_fetch`
   (`core-template-mcp.md:113-117`), and the Rule 2 boot response itself
   (`core-template-mcp.md:127-181`) — together ≈ **8-9K tok** (§2.2).
4. **During-session protocol overhead:** Rule 9 status line every response, module/reference
   lazy-loads (trigger-channel.md before any Trigger dispatch, audit-harness.md on audit
   request, Tier B rules via `prism_load_rules`), checkpoint pushes (§2.3).
5. **Finalization phase:** `prism_finalize` audit → draft → commit payloads, bounded on the
   request side by the INS-178 wall (§2.4).

**First-exchange all-in reconciliation:** 34.2K (boot payload) + ~2.7K (3 tool_search re-deliveries)
+ ~4.3K (sidecar) + ~1.1K (Rule 2 boot response output) + ~5K (platform, modeled) + ~1.5K (opening
exchange, Rule 9 model) ≈ **~48.8K tok ≈ 24.4% of a 200K window** — consistent with the observed
~29% (live sessions add real warnings, larger openings, attachments, and any second fetch; boots
"near 50%" additionally reflect Project-Knowledge attachments and early follow-on fetches, which
are outside the server's control). The pinned `context_estimate` (41,368 = 20.7%) undercounts the
real first exchange because `tool_schema_tokens: 2500` and `platform_overhead_tokens: 5000` are
hardcoded (`src/tools/bootstrap.ts:1444-1445`) and the sidecar fetch, Rule 2 response, and
dialogue are not modeled at all.

---

## §2 Task A — measured component inventory

### §2.1 Bootstrap payload, field by field

Reconstructed wire total **119,662 B** (tripwire-point measurement 119,409 B → 33,879 est tok;
live S202: 33,868). Fields in descending size; "cadence" says whether the cost recurs every
session or is amortized across sessions.

| # | Field | Bytes | Est tok | % of payload | Cadence | Source + citation |
|---|---|---|---|---|---|---|
| 1 | `behavioral_rules` | 42,689 | 12,197 | 35.7% | **every boot, static** | `_templates/core-template-mcp.md` v2.29.0 delivered verbatim (`bootstrap.ts:711-714,1381`); source file 42,579 B + JSON escaping |
| 2 | `standing_rules` (17 Tier-A bodies) | 24,378 | 6,965 | 20.4% | every boot; grows as rules are minted | union of `.prism/standing-rules.md` (326,087 B source) ∪ `insights.md` (37,376 B source), Tier A filter (`bootstrap.ts:1145-1174`, `standing-rules.ts:280-282`) |
| 3 | `standing_rules_index` (102 B+C entries) | 19,873 | 5,678 | 16.6% | every boot; grows | Tier B (86) ∪ Tier C (16) `{id,title,tier,topics}` (`bootstrap.ts:1185-1188`). Composition: titles 12,253 B (62%), topics 2,843 B, ids+tiers 1,206 B, JSON keys/envelope 3,571 B — avg 195 B/entry |
| 4 | `intelligence_brief` (D-253 compact) | 7,145 | 2,041 | 6.0% | every boot; re-synthesized per finalize | 3-section digest of the 10,592 B source brief (`compactIntelligenceBrief`, `bootstrap.ts:258-292,1115`) |
| 5 | `prefetched_documents` (3 entries) | 4,005 | 1,144 | 3.3% | keyword-dependent | glossary summary 560 B + task-queue summary 2,009 B + pending-doc-updates summary 1,162 B + wrappers (`bootstrap.ts:833-882,1018-1032`; `summarizer.ts:17-34`). Source docs are fetched server-side (82.0KB glossary) but only summaries are delivered |
| 6 | `critical_context` (5 items) | 3,538 | 1,011 | 3.0% | every boot; handoff-authored | parsed from handoff `## Critical Context` (`bootstrap.ts:770-772`) — 708 B/item average |
| 7 | `autonomous_work_loop` | 3,305 | 944 | 2.8% | **every boot, static** | constant object (`src/utils/autonomous-work-loop.ts:28-98`) |
| 8 | `recent_decisions` (last 15) | 3,261 | 932 | 2.7% | every boot | `_INDEX.md` tail slice (`bootstrap.ts:814`) |
| 9 | `boot_masthead_svg` | 2,620 | 749 | 2.2% | every boot | server-rendered SVG (`bootstrap.ts:1349-1356`; D-249) — 2,351 B raw + escaping |
| 10 | `guardrails` (20) | 2,541 | 726 | 2.1% | every boot | SETTLED-decision blend, cap 20 (`bootstrap.ts:799-812`) |
| 11 | `banner_text` | 1,240 | 354 | 1.0% | every boot | unified banner (`bootstrap.ts:1334-1343`) — 1,226 B raw |
| 12 | `current_state` | 1,151 | 329 | 1.0% | every boot | handoff `## Where We Are` |
| 13 | `next_steps` (5) | 732 | 209 | 0.6% | every boot | handoff numbered list |
| 14 | `expected_tool_surface` | 675 | 193 | 0.6% | every boot, static | `tool-registry.ts:79-93` (32 names) |
| 15 | `post_boot_tool_searches` | 300 | 86 | 0.3% | every boot, static | `tool-registry.ts:117-125` |
| 16 | `recommended_session_settings` | 204 | 58 | 0.2% | every boot | persisted block re-read from handoff (`bootstrap.ts:1289-1299`) |
| 17 | scalars + `warnings` + `open_questions` + `trigger_enrollment` + misc | ~700 | ~200 | 0.6% | every boot | project/session ids, sizes, flags, spec versions (`bootstrap.ts:1358-1400`) |
| 18 | post-measurement attachments (`context_estimate`, `response_bytes`, `bytes_delivered`, `diagnostics`) | ~253 | ~72 | 0.2% | every boot | attached after the tripwire measurement (`bootstrap.ts:1449-1465`); grows with diagnostic count |
| 19 | JSON envelope (keys/quotes/commas) | 1,576 | 450 | 1.3% | every boot | `responseBytes − attribution.total` |
| | **Total** | **119,662** | **~34,189** | 100% | | live S202: 33,868 tok at the tripwire point |

**Concentration:** the top 3 fields (behavioral_rules + Tier-A bodies + B/C index) are
**86,940 B ≈ 24,840 tok = 72.7%** of the whole payload. Everything else combined is ~9.3K tok.

**Drift since S167:** S167 measured 115,842 B final wire (`s167-server-audit.md:705`); this
reconstruction is 119,662 B — **+3,820 B in 35 sessions**, driven by registry growth (the
append-only standing-rules registry: 119 active rules now vs 134 total then with different
tiering after the S172 manifest pass) and handoff/brief churn. The trend confirms the S167
warning that the payload grows toward the ~234-246KB platform-offload cliff absent lifecycle
management (`src/config.ts:72-87`).

### §2.2 Post-boot protocol turns (template-mandated, same first exchange)

| Component | Bytes (measured) | Est tok | Cadence | Notes |
|---|---|---|---|---|
| 3 × `tool_search` result re-delivery (32 schemas) | 7,131 raw | 2,037 raw; **~2.4-3.1K with result framing** *(framing multiplier is an assumption)* | every boot | Raw = Σ per-tool name+description+JSON-schema, measured by registering all 32 tools against a real `McpServer` and serializing (largest: `prism_finalize` 654 B, `gh_set_branch_protection` 474 B). Mandated by `core-template-mcp.md:106-111` because default MCP relevance ranking loads only a subset (D-83). The server's `tool_schema_tokens: 2500` estimate is *coincidentally* near the raw mass but is hardcoded (`bootstrap.ts:1445`) |
| Codex sidecar `prism_fetch` | 14,482 content + envelope ≈ ~15.0K | **~4,300** | every boot (when files exist — they do on prism) | `.prism/codex/latest-resume.md` 5,259 B + `latest-session.json` 9,223 B at prism `0801b36`; mandated at `core-template-mcp.md:113-117`. Matches the pinned "~14.5KB" |
| Rule 2 boot response (Claude OUTPUT tokens) | ~4.0K | **~1,130** | every boot | Session fence + rename line + `show_widget` re-emitting `boot_masthead_svg` VERBATIM (2,351 B — the SVG is paid twice: once as tool result, once as output) + banner_text tail re-rendered verbatim (~1.1KB) + opening statement + Rule 9 line (`core-template-mcp.md:131-181`) |
| Platform load (system prompt + Project Instructions + initial tool defs) | n/a | **~5,000 (modeled)** | every boot | Server constant (`bootstrap.ts:1444`); Project Instructions template alone is 3,521 B ≈ 1,006 tok. *Assumption — not server-measurable* |

### §2.3 During-session protocol overhead

| Component | Bytes (source) | Est tok | Cadence |
|---|---|---|---|
| Rule 9 status line | ~30 B/response | ~9/response | every response (`core-template-mcp.md:220-230,299-309`) |
| `reference/trigger-channel.md` | 19,979 | 5,708 | before any Trigger dispatch (`core-template-mcp.md:74`) — most working sessions |
| `modules/audit-harness.md` | 18,763 | 5,361 | on audit request only |
| `reference/mcp-tool-surface.md` | 13,166 | 3,762 | on demand |
| `modules/onboarding.md` | 11,792 | 3,369 | new-project only |
| `modules/error-recovery.md` | 3,677 | 1,051 | on corruption/failures only |
| Tier-B rule bodies via `prism_load_rules` | 2-5KB/topic typical | ~600-1,400/topic | on topic demand (D-156/D-253 lazy path) |
| Checkpoint `prism_push` round-trips | request+response ≈ content size | varies | Rule 8 |

### §2.4 Finalization phase

Request-side cost is Claude OUTPUT tokens (the INS-178 wall: token-generation rate for `files[]`
content is the finalize bottleneck, so protocol discipline is handoff-only ≈ 6KB ≈ ~1.7K output
tok). Response shapes from `src/tools/finalize.ts`; magnitudes are **estimates** from those shapes
(finalize was not executed for this read-only audit):

| Phase | What enters context | Est tok |
|---|---|---|
| `action=audit` response | audit checklist + `session_end_rules` = `_templates/rules-session-end.md` **7,205 B delivered lazily here, not at boot** (`finalize.ts:2569,2611`) + diagnostics | ~2.9K |
| `action=draft` response | 6-key draft JSON (proposed handoff + session-log + task-queue content; CS-1 output ~3K tok per `docs/cost-rearchitecture/d275-audit-design.md` §2) + diagnostics (`finalize.ts:2660-2677`) | ~2.5-3.5K *(est)* |
| `action=commit` request | `files[]` content — INS-178-walled to handoff.md | ~1.7K output *(est)* |
| `action=commit` response | per-file results + `banner_text` + `finalization_banner_html` widget + diagnostics (`finalize.ts:2840-2852`), widget re-emitted verbatim per the Mandatory Banner Rendering rule (`core-template-mcp.md:313-322`) | ~2-3K *(est)* |
| **Finalization total** | | **~9-11K** *(est)* |

**Note:** Rules 10-15 being delivered by `prism_finalize` instead of at boot
(`core-template-mcp.md:289-295`) is the existing, working precedent for lazy-loading behavioral
text — the kernel-split proposal (P-2) generalizes exactly this pattern.

---

## §3 Prior-art reconciliation — what was already tried, what it saved, why boot still costs ~40K+

Chronology of every prior boot-payload intervention, from the briefs-branch archive and merged PRs:

| Intervention | What it did | Effect | Why the standing cost survived it |
|---|---|---|---|
| **D-47** (S25) | Original payload optimization: compact brief digest, procedure-only standing rules | First diet | Later reversed by R7-b |
| **D-83** (S44) + S105/brief-446 keywords | Added `post_boot_tool_searches` + `expected_tool_surface` to close the 5-of-18 tool-loading gap | **Added** ~2.4-3.1K tok/boot of schema re-delivery — a deliberate fidelity>size trade | Cost accepted; never revisited with lazy category loading |
| **brief-431** (S146 audit) | Found the estimate numerator omitted ~13 fields and the 200K denominator claim | Diagnosis only | — |
| **brief-433 / PR #55** (R7-a) | `DEFAULT_CONTEXT_WINDOW_TOKENS` 200K→500K + full-payload numerator (`bootstrap.ts:1419-1421`) | Honest *estimate*; zero payload change | Accuracy fix, not a diet — and production later re-pinned the divisor to 200K (brief-449 Change 4.5) |
| **brief-443 / PR #60** (R7-b) | DELIBERATE ENRICHMENT: full 6-section brief, decisions→15, guardrails→20, prefetch cap removed, Tier A+B bodies at boot, under the "500K context" rationale | prism boots hit **234-246KB** → exceeded the Claude.ai inline tool-result cap → the ENTIRE response was sandbox-offloaded and **zero bytes reached the session** (D-253, `bootstrap.ts:1101-1113`) | The growth direction; corrected next |
| **brief-449 / PR #69** (D-253) | Partial R7-b reversal: Tier-A-only bodies + B/C index, spec-coupled brief compaction with `BRIEF_COMPACT_FALLBACK`, in-response oversize tripwire, `response_bytes` | S161's 248,016 B (standing_rules alone 182,992 B) → back to ~115KB steady state | Restored the ~115KB baseline but kept: full template verbatim, ALL Tier-A bodies, and a B/C index that itself now costs 19.9KB |
| **brief-465 / PR #81** (W3-S6, M-012) | Alias removal (`standing_rules_tier_c_index` dup, ~2,836 B — SRV-109), summary header cap (SRV-74), delivered-byte attribution (SRV-39/68), honest `bytes_delivered` (SRV-28), tripwire recalibration 160/200KB | ~3-4KB trimmed + instrumentation that this audit reuses | Mechanical trims only — by design. The brief itself declared the big lever out of scope: *"the template-content diet rides W3-F2/M-021 + W3-F3/M-019 — framework briefs, not landed"* |
| **D-275 audit §6 row F-3** (S196) | Flagged the standing cost: ~115KB ≈ ~33K tok/session × ~25 sessions/mo ≈ **~825K chat tok/mo**; proposed GLM-side compression experiments; **risk HIGH** (behavioral-rules fidelity), "experiments only, gated on D-253 lessons" | Design row only | This brief (s202a) is that follow-up |

**Net answer to "why is it still ~40K+":** every landed intervention either (a) fixed
*measurement honesty* (433, 465-instrumentation), (b) trimmed *server-side mechanical* fat
(449, 465 — worth ~130KB off the R7-b peak but only ~6-7KB below the pre-R7-b baseline), or
(c) explicitly deferred the two dominant levers as framework-side work that **never landed**:
the template content itself (42.7KB, W3-F3/M-019 — no framework brief ever shipped it) and the
registry lifecycle (INS-363's operator-curated retirement pass — logged S193, still pending).
The top-3 concentration (72.7%) sits exactly in those never-landed levers, plus a third one
nobody has audited until now: the **B/C index** D-253 itself introduced, which has silently
grown to 19.9KB — 84% of the size of the Tier-A bodies it was meant to slim.

---

## §4 Task B — value/redundancy analysis per component

### B.1 `behavioral_rules` — 42,689 B (~12.2K tok), the same static text every boot

Section-level accounting of `core-template-mcp.md` v2.29.0 (353 lines; line refs):

| Section (lines) | ~Bytes | Consumed | Class |
|---|---|---|---|
| Header (1-9) | ~0.5K | boot turn | kernel |
| Operating Posture incl. model-awareness/triage (11-36) | ~7.4K | posture: always; triage detail: boot turn only | kernel (trim candidate: triage branches ~3.5K fire once) |
| Interaction Rules (40-49) | ~1.9K | always | kernel |
| CC Channel Discipline + D-274 mandate (53-90) | ~7.3K | **only when dispatching** — and the HOW already lazy-loads via `trigger-channel.md` (line 74) | **deferrable** (the WHEN/mandate could compress to a kernel pointer + hard rule line) |
| Rule 1 bootstrap mechanics + post-boot searches + sidecar + recommendation + stale-active (95-125) | ~6.6K | boot turn only | boot-turn module (must be in context AT boot, but is dead weight for the remaining ~99% of the session — candidates for post-boot dropout do not exist in a linear context; only shrinking helps) |
| Rule 2 boot response template + FORBIDDEN list + fallback (127-181) | ~4.6K | boot turn only | same as above |
| Rule 2A autonomous work loop (185-192) | ~2.6K | during work | **REDUNDANT — near-verbatim duplicate of the `autonomous_work_loop` field (3,305 B)**; the template even documents the overlap ("Older clients that do not receive `autonomous_work_loop` still follow this Rule 2A text", line 192, mirrored at `autonomous-work-loop.ts:91-93`). Both are delivered on every boot: **~5.9KB paying twice for one contract** |
| Rules 3-8 (194-218) | ~2.9K | always | kernel |
| Rule 9 + estimation formula (220-274) | ~3.9K | every response | kernel (the formula body ~2.2K is consulted once to set up the meter) |
| Document Ingest D-270 (276-285) | ~2.4K | **only on upload/deliverable** | **deferrable**; also duplicated by Tier-A rule INS-354 (1,211 B) — see B.2 |
| Session End note — Rules 10-15 pointer (287-295) | ~1.5K | finalization | already lazy (full text ships in `prism_finalize` audit — the precedent) |
| Rule 9 restatement / Mandatory Response Closer (299-309) | ~1.1K | always | **REDUNDANT with Rule 9 by design** (D-85 anti-omission); keep-or-fold is a fidelity judgment, not a fact question |
| Mandatory Banner Rendering (313-322) | ~1.6K | boot + finalize turns | partially redundant with Rule 2 item 3/4 + finalize module |
| Module Triggers table (326-340) | ~1.0K | on trigger | kernel (it IS the lazy-load map) |
| Design Constraints (344-350) | ~1.1K | reference | mostly duplicates server-enforced facts (10-doc list is enforced by finalize; decision-domain split is server behavior) |

**Boot-critical kernel vs deferrable/duplicated (measured from the section map):** a
strictly-kept kernel (posture core, interaction, Rules 1-9 with boot-turn text intact, module
map, closers) is ~**26-28KB**; ~**10-11KB** is deferrable to trigger-loaded modules (CC
discipline, ingest, triage detail) and ~**4-5KB** is duplication (Rule 2A vs field, Rule 9
restatement, banner-mandate overlap, design constraints vs server validation). An aggressive
but fidelity-honest kernel target is **~18-22KB** (see P-2; the floor argument is in the
proposals doc).

**Server-enforceable overlap:** commit prefixes, EOF sentinels, handoff schema, decision-ID
dedup, doc completeness — all validated server-side today (`src/validation/*`,
`prism_log_decision` dedup, finalize `HANDOFF_SCHEMA_MISSING`). The template text about them is
*advisory redundancy*; only the operative "the server will reject X" one-liners are needed for
behavior. Trimmable prose is real but modest (~1-2KB) because the template already mostly
points rather than specifies.

### B.2 Tier-A standing rules — 17 bodies, 24,378 B (~7.0K tok)

Per-rule delivered bytes (serialized), with disposition analysis:

| Rule | Bytes | Always-load justification | Finding |
|---|---|---|---|
| INS-178 finalize `files[]` wall | 2,761 | Fires only at finalization | **Demote to B (topic: finalize)** — or deliver with the finalize audit response alongside `session_end_rules`, its natural home |
| INS-226 GitHub via MCP directly | 2,449 | Operator preference, any session | Keep A; body is 2.4KB of history — trim to procedure |
| INS-187 PAT-rotation surfacing suppression | 2,088 | Fires only when credentials come up | **Demote to B (topic: credentials)** |
| INS-193 absolute paths in shell commands | 1,956 | Fires when emitting shell commands | Borderline — frequent in this fleet; keep A, trim body |
| INS-324 self-dequeue dispatch mechanics | 1,671 | Fires only when authoring/dispatching briefs | **Demote to B (topic: trigger)** |
| INS-340 protocol changes fleet-wide | 1,541 | Fires only when authoring protocol changes | **Demote to B (topic: framework)** — topics already tagged |
| INS-40 verify-don't-trust | 1,366 | Every session | Keep A |
| INS-230 CC channel discipline | 1,220 | — | **RETIRE/archive: duplicated AND partially superseded by the template's own CC Channel Discipline section** (`core-template-mcp.md:63-67` — "size is not a reason" supersedes INS-230's "cc_dispatch for simple/small only"). Boot pays 1.2KB to carry stale guidance that conflicts with a stronger fleet rule |
| INS-354 D-270 auto-ingest | 1,211 | — | **RETIRE/archive: verbatim-duplicates the template's Document Ingest section** (`core-template-mcp.md:276-285`, D-270 fleet-wide) |
| INS-304 guess-vs-verify | 1,182 | Every session | Keep A |
| INS-319 Step-0 attestation in CC briefs | 1,104 | — | **RETIRE: superseded by D-267** (attestation → daemon-side preflight gate; this s202a brief itself prohibits Step-0 sections per D-267). A retired protocol step is boot-loaded as Tier A every session |
| INS-354/others cont. | — | — | — |
| INS-260 autonomy preference | 1,735 | Every session | Keep A |
| INS-34 conversation-search-first | 864 | Every session | Keep A |
| INS-292 verify 3-server tool surface at start | 967 | Boot turn | Fold into Rule 1 text (already does post-boot searches) or keep A (small) |
| INS-318 clickable links | 819 | Every session | Keep A (duplicates Interaction Rules "Clickable links always" — could retire into template) |
| INS-302 conciseness directive | 712 | Every session | Keep A (duplicates Operating Posture "Brevity is mandatory" — could retire into template) |
| INS-291 sequential instructions | 714 | Every session | Keep A (duplicates Interaction Rules bullet 1 — could retire into template) |

**Sums:** clear demotions (178, 187, 324, 340) = **8,061 B**; retire-as-duplicate/superseded
(230, 319, 354, and template-covered 291/302/318 if the operator agrees) = **2,535-4,780 B**.
A curated Tier A of ~8-10 rules ≈ **~10-13KB** vs today's 24.4KB, all via registry-only
`[TIER:X]` edits (INS-363's requested retirement pass; mechanics in P-5). Note the general
pattern: **project-scoped Tier-A rules that later went fleet-wide into the template are never
cleaned up** — the registry has no supersession lifecycle (INS-363), so boot pays for both
copies indefinitely.

### B.3 Prefetch — measured hit economics

S202-scenario delivery: 4,005 B total — glossary summary **560 B** (of an 81,986 B source),
task-queue summary 2,009 B, pending-doc-updates summary 1,162 B. Two corrections to the pinned
framing, per the measurement:

1. The "82KB glossary" **did not enter context** — `summarizeMarkdown` delivers a 500-char
   preview + ≤25 headers (`summarizer.ts:17-34`, SRV-74). The 82KB cost is server-side fetch
   time and `bytes_delivered` accounting, not context. Context cost of the unused prefetch was
   ~160 tok, not ~23K.
2. The real inefficiencies are: (a) keyword false positives — `PREFETCH_KEYWORDS`
   (`config.ts:461-489`) fires on generic words ("term", "task", "priority") in the opening
   message or next_steps, so most boots carry 1-3 summaries regardless of need; (b) **zero
   consumption telemetry** — nothing records whether a prefetched summary was ever used, so hit
   rate is unmeasurable today (S202's glossary miss is known only from operator observation);
   (c) the summaries duplicate what `prism_fetch(summary_mode)` would return on demand for ~1
   extra tool call.

Total exposure is bounded (~0.9-1.4K tok/boot post-SRV-74) — this is a hygiene item, not a
headline lever. P-4 covers the policy fix.

### B.4 `intelligence_brief` + handoff-derived fields overlap

Boot delivers two narrations of the same project state: the compacted brief (7,145 B: 3-sentence
Project State digest + FULL Risk Flags + FULL Quality Audit) and the handoff-derived structured
fields (critical_context 3,538 + current_state 1,151 + recent_decisions 3,261 + guardrails 2,541
+ next_steps 732 = 11,223 B). Overlap observed in the prism worked example: the brief's Project
State digest restates `current_state`; Risk Flags substantially restate `critical_context` items
and known-issues entries; both carry recent-decision narrative that `recent_decisions` already
lists. The brief's *unique* boot value concentrates in Risk Flags deltas and the Quality Audit
(which the INS-370 zero-drift gate consumes at boot). The handoff fields are the resumption
spine and must stay. **Redundancy estimate: ~2.5-4KB/boot** of restated state — P-3 proposes a
headline-block delivery with on-demand full sections rather than deeper compaction (D-253's
lesson: compaction must be spec-coupled and fallback-guarded, never literal-matched).

### B.5 Masthead SVG vs text banner

Both are delivered (2,620 + 1,240 B) AND both are re-emitted by Claude in the Rule 2 response
(SVG verbatim via `show_widget`, banner_text tail verbatim) — the banner surface costs
**~7.4KB ≈ ~2.1K tok per boot all-in**, of which the SVG accounts for ~1.4K tok (delivered +
re-emitted). The text banner alone carries every operational datum (session line, counts,
status row, resumption, next steps, warnings, Suggested line); the SVG adds visual identity
only. This is a deliberate operator choice (D-249 reversed R8's text-only deprecation), so P-6
treats it as an opt-in knob, not a silent removal. The template already specifies the exact
fallback behavior when `boot_masthead_svg` is null (`core-template-mcp.md:175-181`), so the
degrade path is pre-built and tested by production render-failure handling.

### B.6 Tool-surface verification — 3 × 20-result searches vs a checksum

The three searches exist to **load** tool schemas (deferred tools are not callable until
loaded), not merely to verify — so a server-delivered checksum **cannot replace them** without
losing mid-session callability; `expected_tool_surface` (675 B) already IS the
verification-side manifest. The honest lever is *scope*, not existence: a boot session loads
all 32 schemas (~2.4-3.1K tok) but a typical session calls 5-8 distinct tools. Deferring the
`github`/`railway` category searches to first need (template-line change; the queries are
server-supplied data at `tool-registry.ts:117-125`) saves ~60% of the re-delivery on boots that
never touch them, at the cost of a 1-turn search when first needed and re-introducing the
S105-class ranking risk on mid-session searches (mitigation: keep the exact curated queries).
Verdict: real but second-order (~1.3-1.9K tok on qualifying boots).

### B.7 Diagnostics / index / instrumentation fields

`context_estimate` + `response_bytes` + `bytes_delivered` + `diagnostics` + spec-version fields
+ `files_fetched` + `boot_test_verified` + `trigger_enrollment` ≈ ~1.2KB total. All either
drive the Rule 9 meter (`total_boot_tokens` is the meter's anchor per
`core-template-mcp.md:257`) or are the instrumentation the payload diet itself depends on
(SRV-28/39/68). **No action recommended** — cutting instrumentation to save ~0.3K tok would
blind exactly the loop this audit runs on. The one large "index" field, `standing_rules_index`
(19.9KB), is analyzed in B.2/§2.1 and targeted by P-1/P-5: its cost is 62% titles, its
consumer contract (the session "consults the index to lazy-load" —
`core-template-mcp.md:104`) needs only id + short-title + topics to function, and its size
scales with total registry population (102 entries), not with what the session will ever load.

<!-- EOF: s202-boot-context-audit.md -->
