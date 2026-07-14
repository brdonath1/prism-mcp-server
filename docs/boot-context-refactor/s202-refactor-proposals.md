# S202 Boot-Context Refactor Proposals (Tasks C + D) — brief-s202a

Companion to `s202-boot-context-audit.md` (measured inventory; all numbers below reference it)
and `s202-component-inventory.json`. Design-only: no src/, template, or env change is made by
this document.

**Baseline (measured, §2 of the audit):** prism bootstrap payload 119,662 B ≈ **33.9K tok**;
first exchange all-in ≈ **~48.8K tok ≈ 24.4%** of the production 200K window (observed 29-50%
with operator-side additions). Top-3 concentration: behavioral_rules 12.2K tok + Tier-A bodies
7.0K + B/C index 5.7K = **72.7%** of the payload.

---

## §0 Design principles every proposal must satisfy

1. **The fidelity wall (the honest floor):** a model obeys only text that is in its context.
   No manifest, hash, or database can substitute for the rules the session must follow — those
   bytes are irreducible except by *writing them shorter* or *loading them only when their
   trigger condition occurs*. Every "savings" claim below states which side of that wall it is on.
2. **The statelessness floor:** Claude.ai chat sessions share nothing across sessions. A
   server-delivered version hash cannot let a session "skip re-reading unchanged rules" — there
   is no prior read to skip from. Hashes below are used for *drift detection and module
   currency*, never for in-context savings (quantified in P-2).
3. **D-253 lessons (all inherited from the R7-b → D-253 incident chain, brief-449):**
   (a) size growth has a **cliff**, not a slope — at ~234-246KB the platform offloads the whole
   response and *zero bytes* reach the session; headroom is a delivery-correctness property;
   (b) any compaction must be **spec-coupled and fallback-guarded** (the INS-249 silent-drop
   defect class) — never literal-matched, and a missing section falls back to full delivery
   with a loud diagnostic;
   (c) instrumentation attaches **after** measurement so tripwires ship in-response;
   (d) diet decisions must use **delivered-byte attribution**, not source sizes (SRV-68);
   (e) field removals are **two-phase** with consumer verification (SRV-109 alias precedent).
4. **F-3 HIGH-risk reconciliation (d275-audit-design.md §6):** F-3 flagged behavioral-rules
   fidelity as the HIGH risk and demanded experiments gated on D-253 lessons. Accordingly,
   every proposal here (i) names its **audit-harness verification** (the v4 harness,
   `_templates/modules/audit-harness.md`: Probe B boot-contract, C Rule 9, D
   unverified-assertion, F finalize-contract, G warnings-surfaced, with the S157/S177
   calibration anchors), (ii) has an **env-or-template-only rollback**, and (iii) is sequenced
   so the HIGH-risk items land last, after the zero-risk items have banked savings.
5. **INS-340:** anything protocol-level lands in `prism-framework` templates (fleet-wide),
   never as a single-project patch. Per-proposal "migration path" names the owning repo.
6. **Verification instrument, defined once:** *"harness gate"* below = run the audit-harness v4
   over ≥3 sessions before and ≥5 sessions after the change; require no regression in Probe
   B/C/F/G pass rates and no new Probe-D confirmed findings attributable to a missing rule;
   include the S157 (boot `partial`) and S177 (finalize `fail`) calibration anchors on the
   first run of any new probe. Where a proposal changes synthesis-produced content, add the
   INS-370-style zero-drift claim check on the first post-change artifact.

---

## §1 Task C — proposals

### P-1 Machine-readable session-state manifest (the operator's JSON / light-SQL direction, assessed honestly)

**Design.** Add a compact `session_state_manifest` field to the bootstrap response:

```json
{ "docs": [{ "path": ".prism/glossary.md", "sha": "…", "bytes": 82207,
             "sections": [{ "h": "## Terms A-F", "bytes": 14200 }] }],
  "rules": { "total": 119, "tier_a_delivered": 17,
             "index": [{ "id": "INS-244", "t": "B", "topics": ["synthesis"], "title60": "cc_subprocess wrapper-success without token-count check is unsa…" }] },
  "brief": { "synthesized": "S201", "sections": ["Project State", "Risk Flags", "Quality Audit"] } }
```

and let the session lazy-load bodies via the tools that already exist (`prism_fetch` with
`summary_mode`/section targeting, `prism_load_rules` by topic/ID). The manifest replaces the
two boot fields whose cost scales with *repository population* rather than *session need*:

- `standing_rules_index` 19,873 B → compact rule index (id + tier + topics + title capped at
  60 chars) ≈ **~4.5KB** (titles are 62% of today's index; audit §2.1 row 3). Saving ≈
  **−15.4KB ≈ −4.4K tok**.
- `prefetched_documents` 4,005 B → manifest doc rows (already covered above) + on-demand
  fetch. Saving ≈ **−4.0KB ≈ −1.1K tok** (interacts with P-4; do not double-count — combined
  P-1+P-4 saving is the same −1.1K).

**Where the direction honestly does NOT help (operator asked for this stated plainly):**

- **Behavioral rules and Tier-A bodies cannot become pointers.** They are on the wrong side of
  the fidelity wall (§0.1): a hash-plus-pointer for INS-40 does not make the session verify
  claims. The manifest saves nothing on the 19.2K tok of behavioral text; only P-2/P-5 do.
- **SQLite is the wrong container for the chat surface.** The session has no SQL runtime; a
  `.sqlite` artifact fetched into chat is opaque bytes that still cost tokens to deliver and
  cannot be read at all. Server-side SQLite behind a query tool is indistinguishable from what
  `prism_fetch`/`prism_search`/`prism_load_rules` already are (server-side retrieval with
  compact responses) — it would re-platform existing GitHub reads with zero context-window
  effect. **Verdict: adopt the JSON manifest; reject SQLite** (a server-side cache/index is a
  latency optimization out of scope for context burn).
- The manifest itself is new bytes (~1.5-2.5KB) — netted in the savings above.

**Est. saving/session:** **−4.5 to −5.5K tok** (index compaction + prefetch replacement, net of
manifest cost). **Fidelity risk: MEDIUM** — the session loses full B/C titles at boot; a
too-aggressive title cap could make a needed Tier-B rule undiscoverable. *Mitigation:* titles
capped not dropped; topics kept whole (they are the `prism_load_rules` match key, only 2,843 B);
harness gate + a new module-load probe (below, P-2 mitigation 3); two-phase migration per
D-253 lesson (e).
**Migration path:** prism-mcp-server brief — release 1 ships `session_state_manifest`
alongside the existing fields behind `BOOT_INDEX_MODE=compact|full` (default `full`);
prism-framework brief teaches the template to consume the manifest; release 2 flips the
default; release 3 drops the legacy index after a consumer grep (SRV-109 pattern).
**Rollback:** env-only — `BOOT_INDEX_MODE=full` restores today's exact index with no deploy.
**Harness verification:** harness gate (§0.6) + assert in the round-trip fidelity test
(brief-465 pattern, `tests/`) that every rule reachable by topic yesterday is reachable today.

### P-2 Behavioral-rules kernel split (the biggest lever; HIGH-risk, last to land)

**Design.** Split `core-template-mcp.md` (42,579 B source) into an always-boot **kernel** and
trigger-loaded **modules**, generalizing the two lazy-load precedents that already work in
production: Rules 10-15 ship in the `prism_finalize` audit response, not at boot
(`core-template-mcp.md:289-295`, `finalize.ts:2569`), and trigger-channel mechanics load
before first dispatch (`core-template-mcp.md:74`).

Kernel (from the section map, audit §B.1): posture core + interaction rules + Rules 1-9 (with
the boot-turn Rule 1/2 text intact) + module-trigger map + the two ⛔ closers, with these
**dedups**: Rule 2A body → 2-line pointer to the `autonomous_work_loop` field (−2.4KB; one
contract, one carrier), Rule 9 restatement folded into Rule 9 (−0.9KB, keeping ONE ⛔ closer
block — D-85's anti-omission intent is preserved by the closer, not by saying it twice),
banner-mandate overlap consolidated (−0.8KB), model-triage branches compressed to 3 lines
(−2.5KB), design-constraints trimmed to the non-server-enforced items (−0.6KB, rides P-7).
Modules (each 1 mandate-line stays in the kernel; the HOW moves out): `cc-channel-discipline`
~7.3KB **merged into `reference/trigger-channel.md`** (which dispatch sessions already load —
net new cost ≈ 0 for them), `document-ingest` ~2.4KB loaded on first upload/deliverable
(kernel line: "on upload → load ingest module BEFORE pushing").

**Kernel size arithmetic:** 42.6KB − 7.3 (CC) − 2.4 (ingest) − 2.4 (2A dup) − 0.9 (R9 restate)
− 0.8 (banner overlap) − 2.5 (triage) − 0.6 (constraints) ≈ **~25.7KB source ≈ ~26KB delivered
≈ 7.4K tok** vs 12.2K today → **−4.7 to −5.2K tok/boot** (deeper posture editing could reach
the 18-22KB aggressive band; treat ~26K as the committed number).

**The version-hash idea, bounded (operator asked):** statelessness (§0.2) means the hash saves
zero in-context tokens — every session must still receive the kernel to obey it. **The floor
is the kernel size itself (~7-7.5K tok as specified, ~5-6K tok at the aggressive edit).** The
hash's real value: the server stamps `behavioral_rules_hash` + per-module hashes so drift
between kernel/modules/template-version is detectable (extends the existing
`Banner-Spec-Version` handshake, `bootstrap.ts:733-753`) — adopt for that reason only.

**Est. saving/session: −4.7 to −5.2K tok** (plus removing the 2A duplication is included).
**Fidelity risk: HIGH — this is exactly F-3's flagged risk.** A deferred rule is a rule the
model cannot obey until loaded. *Mitigations:* (1) every ⛔ HARD mandate stays in the kernel
verbatim — modules carry procedure, never the mandate; (2) module-trigger lines are kernel-side
and imperative; (3) **harness gate with a new Probe H ("module-load compliance"): for each
session that dispatched CC work / ingested a document, verify the transcript shows the module
load before the act** — S191/S192-style graded rows; (4) D-253 lesson (b): the server guards
the split server-side — if the kernel template at `MCP_TEMPLATE_PATH` is missing its
`Kernel-Manifest:` header line, bootstrap falls back to delivering the full legacy template and
emits a `KERNEL_SPLIT_FALLBACK` diagnostic (no silent thinning); (5) stage on ONE project
before fleet-wide.
**Migration path:** prism-framework brief (INS-340): author kernel v3.0.0 + module files;
CHANGELOG + version bump; server change is OPTIONAL (fallback guard + hash stamp only —
delivery path is unchanged since the server ships whatever file sits at `MCP_TEMPLATE_PATH`,
`config.ts:38`).
**Rollback: template-only** — `git revert` of the prism-framework commit restores the monolith
at the same path; the server cache TTL is 5 minutes (`bootstrap.ts:326-339`), so recovery is
near-immediate with **no server deploy**.
**Harness verification:** full gate (§0.6) ≥5 post sessions incl. at least 1 dispatch session
and 1 ingest session for Probe H; abort criterion: any B/C/F/G regression or a Probe-H fail →
revert same day.

### P-3 Tiered handoff + brief delivery (headline at boot, sections on demand)

**Honest scoping from the measurements:** the brief is *already* tiered — D-253 compaction
delivers 7,145 B of a 10,592 B source, and the dropped sections are already fetch-on-demand.
Both surviving sections are load-bearing at boot (Risk Flags = the operational hazards; Quality
Audit = what the INS-370 zero-drift gate reads), so cutting them re-runs the R7-b→D-253 mistake
in reverse. The real remaining fat is on the **handoff side**: `critical_context` averages
708 B/item (5 × ~700 B — items have grown into paragraphs; the template intent is 3-5 *facts*)
and the brief's Project-State digest restates `current_state` (audit §B.4, ~2.5-4KB overlap).

**Design:** (a) finalize-side: the draft prompt (CS-1) and handoff validation gain a
critical-context item budget — warn at >300 B/item (`HANDOFF_ITEM_OVERSIZE` diagnostic, warn
not reject); (b) boot-side: deliver `current_state` OR the brief's Project-State digest, not
both — keep `current_state` (handoff is the resumption spine), and have `compactIntelligenceBrief`
emit Risk Flags + Quality Audit only (drop its digest line — it is the one section with a
measured full duplicate in the same payload); spec-coupled + fallback-guarded per D-253 (b).
**Est. saving/session: −0.9 to −1.5K tok** (≈2.3KB item hygiene once handoffs re-form +
~0.3-1.2KB digest dedup). **Fidelity risk: LOW-MEDIUM** (digest drop is guarded; item budget is
warn-only). *Mitigation:* BRIEF_COMPACT_FALLBACK path already exists; item budget starts
advisory. **Migration:** prism-mcp-server brief (compactor + validation warn) + finalize prompt
line; no template change required. **Rollback:** env `BRIEF_COMPACT_MODE=legacy` (ships digest
again); item budget is warn-only so no rollback needed. **Harness:** gate + INS-370 zero-drift
check on the first post-change brief.

### P-4 Prefetch policy fix

**Design (matching the measured reality — summaries, not bodies, are delivered):**
(a) drop the `next_steps`-keyword auto-trigger (it fires on registry-style words like
"queue"/"task" in nearly every handoff — `bootstrap.ts:845-850`); keep opening-message
keywords (the operator's actual ask signal); (b) keep the SRV-74 caps; additionally cap
summary length at 1,200 B/doc (task-queue's 25-header summary measured 2,009 B); (c) emit a
`prefetch_hint` (file + one-line reason, ~80 B) instead of a summary when confidence is low —
the session fetches on demand; (d) document that doc *bodies* never ship at boot (the ">20KB
body" fear is already structurally impossible post-SRV-74 — `summarizer.ts:17-34`); (e) add
the missing consumption telemetry: log a `PREFETCH_DELIVERED` info diagnostic naming files, so
future audits can compute hit rate from transcripts (today it is unmeasurable — audit §B.3).
**Est. saving/session: −0.6 to −1.0K tok.** **Fidelity risk: LOW** — worst case is one extra
`prism_fetch` round-trip when a summary would have sufficed. **Migration:** prism-mcp-server
brief; env `PREFETCH_MODE=opening_only|legacy`. **Rollback: env-only** (`legacy`).
**Harness:** gate; no dedicated probe (Probe D would surface a session flailing for a doc it
should have had).

### P-5 Standing-rules retirement/demotion pass (INS-363 mechanics)

**Design.** The operator-curated pass INS-363 already calls for, with the concrete curation
list from the audit (§B.2):
- **Retire (archive per D-48 semantics — `ARCHIVED RULE` marker, parser already excludes,
  `standing-rules.ts:163-165`):** INS-319 (superseded by D-267 — currently boot-loads a
  retired protocol step), INS-230 (conflicts with the stronger template CC mandate), INS-354
  (verbatim template-ingest duplicate); *operator's call:* INS-291/302/318 (duplicate template
  posture/interaction bullets). Bytes: 3,535 mandatory + 2,245 optional.
- **Demote A→B with topics:** INS-178 (`finalize`), INS-187 (`credentials`), INS-324
  (`trigger`), INS-340 (`framework, protocol`). Bytes out of boot bodies: 8,061 (they re-enter
  the index at ~195 B each ≈ +780 B; with P-1's compact index ≈ +400 B).
- **Trim survivors:** INS-226/193/260 bodies carry discovery history; procedure-only rewrite
  (the D-47 contract) targets ~40% body reduction ≈ −2.2KB.
- **Registry lifecycle (the durable half of INS-363):** quarterly retirement review + archive
  file (`standing-rules-archive.md`) so the 326KB source file starts shrinking (source-side:
  synthesis-input and load-path relief; boot-side effect is the tiering above).

**Est. saving/session: −3.2 to −4.3K tok** (Tier-A bodies 24.4KB → ~10-13KB serialized, net of
index growth). **Fidelity risk: LOW-MEDIUM** — demoted rules regain loadability by topic
(unlike a deletion); retired rules live on in the template text that superseded them.
*Mitigation:* operator reviews the curation list rule-by-rule (this doc is the proposed list,
not a fait accompli); batch of ≤6 changes per session with a 2-session soak; Probe D watch for
behavior the demoted rules governed. **Migration:** prism repo registry edits only
(`[TIER:X]` tags + archive markers) — **zero deploy, zero template change**; a follow-up
fleet-wide template line is NOT needed (tiering is per-project data). **Rollback:** git revert
of the registry commit (data-only). **Harness:** gate; Probe D specifically instructed to flag
finalize-wall / dispatch-mechanics violations (the demoted rules' domains).

### P-6 Banner / tool-surface slimming

**(a) Masthead SVG knob.** `BOOT_MASTHEAD_SVG=off` → server ships `boot_masthead_svg: null`;
the template's pre-built fallback renders `banner_text` only (`core-template-mcp.md:175-181`).
Saves 749 tok delivered + ~670 tok of Rule 2 re-emission ≈ **−1.4K tok/boot**. This reverses an
explicit operator choice (D-249 restored graphical banners), so it ships **default-on (no
behavior change)** as a per-deployment knob the operator can flip during a context-pressure
push. Risk LOW (fallback path is production-tested by render-failure handling). Rollback:
env-only. Harness: Probe B block-grading confirms the fallback boot shape.
**(b) Deferred category tool-loading.** Template edit: at boot run only the `prism` search
(query 1 of `tool-registry.ts:117-125`); run the `railway/cc` and `github` searches at first
need, using the exact server-supplied queries (they remain in `post_boot_tool_searches` —
data unchanged, consumption re-staged). Saves ~60% of the ~2.4-3.1K tok re-delivery on boots
that never touch those categories ≈ **−1.3 to −1.9K tok** on qualifying boots (most
non-dispatch sessions). Risk MEDIUM: a mid-session search costs one turn; the Tool Surface
banner line changes semantics (shows `core ✓14/14 | railway deferred | gh deferred` — template
text change); the S105 ranking-gotcha class returns if queries are ever improvised
(*mitigation: template mandates the server-supplied queries verbatim*). Rollback:
template-only revert. Harness: gate + Probe B (Tool Surface line shape).

### P-7 Server-side enforcement replacing in-context prose

**Assessment (honest):** the big validation classes (EOF sentinels, commit prefixes, handoff
schema, decision-ID dedup, doc completeness, size tripwires) are **already server-enforced**,
and the template already mostly *points* at them — the removable advisory prose is ~1-2KB
(rides P-2's kernel edit; no separate brief). The genuinely new enforcement wins are small and
additive: (a) P-3's critical-context item budget (warn); (b) P-4's prefetch telemetry;
(c) a `TEMPLATE_SECTION_MANIFEST` check — server verifies the kernel's section list at
delivery (P-2 mitigation 4). No proposal here can move behavioral text server-side: a
validator can reject a bad artifact after the fact, but only in-context rules shape the
behavior that produces it (§0.1). **Est. saving:** included in P-2's figure (do not
double-count). **Risk:** LOW. **Rollback:** rides the carrying proposals.

---

## §2 Task D — phased implementation plan

Savings are stated against the measured 33.9K-tok bootstrap / ~48.8K first exchange, prism
worked example, 200K window. Phases are strictly ordered so each banks verified savings before
the next raises risk. Every phase = one implementing brief (named), one verification gate, one
rollback lever.

| Phase | Scope (proposals) | Owner repo / brief | Est. bootstrap after | Δ tok | Verification gate | Rollback |
|---|---|---|---|---|---|---|
| **0a** | P-5 batch 1: retire INS-319/230/354, demote INS-178/187/324/340, trim INS-226/193/260 (operator reviews list first) | `prism` registry edits — brief-s2xx (zero code, zero deploy) | 119.7KB → ~106KB ≈ **30.3K tok** | **−3.6K** | harness gate ≥3/≥5 sessions; Probe D watch on demoted domains | git revert registry commit |
| **0b** | Template micro-dedups: Rule 2A → pointer, Rule 9 restatement fold, banner-mandate consolidation, triage compression, constraints trim (the P-2 dedup subset ONLY — no module split yet) | `prism-framework` — brief-s2xx (template-only) | ~106KB → ~99KB ≈ **28.3K tok** | **−2.0K** | harness gate; Probe B/C unchanged pass rates; KERNEL not yet split so no Probe H needed | git revert template commit (5-min cache) |
| **1** | Server knobs: P-1 compact index (`BOOT_INDEX_MODE`, default `full` → flip after soak), P-4 prefetch (`PREFETCH_MODE`), P-3 digest dedup + item-budget warn, P-6a SVG knob (default on) | `prism-mcp-server` — brief-s2xx | ~99KB → ~79KB ≈ **22.6K tok** | **−5.7K** | brief-465-pattern round-trip fidelity test (field-complete, byte-smaller); harness gate; INS-370 zero-drift on first post-change brief | env-only: `BOOT_INDEX_MODE=full`, `PREFETCH_MODE=legacy`, `BRIEF_COMPACT_MODE=legacy` |
| **2** | P-2 kernel split (kernel ~26KB + cc-discipline merged into trigger-channel + ingest module) + P-6b deferred category searches; P-7 prose trims ride the kernel edit | `prism-framework` — brief-s2xx (template-only; optional server fallback-guard brief) | ~79KB → ~62KB ≈ **17.7K tok** | **−4.9K** (+ ~−1.6K post-boot searches on non-dispatch boots) | FULL harness gate ≥5 sessions incl. 1 dispatch + 1 ingest session; new Probe H (module-load compliance); S157/S177 anchors; single-project stage before fleet | git revert template commit — **no deploy** |
| **3** | P-1 full manifest (`session_state_manifest` + legacy-index removal after consumer grep) + P-5 batch 2 (quarterly lifecycle + deeper survivor trims) | `prism-mcp-server` + `prism` — brief-s2xx | ~62KB → ~53KB ≈ **15.1K tok** | **−2.6K** | round-trip fidelity test v2 (manifest-driven lazy loads); harness gate | `BOOT_INDEX_MODE=full` (release-1 alias retained until grep-verified) |

**End-state budget and the arithmetic that gets there (target: boot ≤ 12-15K tok):**

| Component | Today (tok) | End-state (tok) | How |
|---|---|---|---|
| behavioral kernel | 12,197 | ~7,000 | P-2 (26KB kernel) — floor per §0.2 |
| Tier-A rule bodies | 6,965 | ~2,900 | P-5 (8-10 trimmed rules ≈ ~10KB) |
| rules index / manifest | 5,678 | ~1,300 | P-1 compact (title60 + topics) |
| intelligence brief | 2,041 | ~1,800 | P-3 digest dedup (RF+QA kept whole) |
| handoff-derived fields | 3,216 | ~2,300 | P-3 item budget (as handoffs re-form) |
| work loop (single carrier) | 944 | 944 | P-2 keeps the field, kills the text dup |
| banner text + SVG | 1,103 | 1,103 (or 354 SVG-off) | P-6a knob, operator's call |
| prefetch | 1,144 | ~250 | P-4 hints |
| misc + envelope + attachments | 1,591 | ~1,400 | mostly structural |
| **bootstrap total** | **33,879** | **~13.7-14.4K tok** (SVG on) / **~13.0-13.7K** (SVG off) | **inside the 12-15K target band** |

First-exchange all-in at end-state: ~14K (bootstrap) + ~5K (platform, unchanged — outside
server control) + ~0.9K (1 boot search, P-6b) + ~4.3K sidecar (unchanged — PRISMA-owned; a
sidecar digest is flagged as future work for its owner, potential −3K more) + ~0.7K (Rule 2
response, text-tail) + ~1.5K (opening exchange) ≈ **~26.4K ≈ 13.2% of 200K**, vs ~48.8K/24.4%
measured today (and 29-50% observed) — a **46% first-exchange reduction with zero dropped
protocol behavior**, every byte either relocated behind its trigger condition, deduplicated, or
retired-as-superseded. Monthly (F-3 basis, 25 sessions): bootstrap alone drops ~20K tok/session
≈ **~500K chat tok/mo**, double F-3's 200-250K target, because this plan reaches the two levers
F-3's compression-only scoping could not (template restructure + registry lifecycle).

**Standing risk register for the whole plan:** (1) the D-253 cliff is retired permanently by
Phase 1's smaller baseline (worst-case regrowth from 53KB has ~4× headroom to the 200KB error
tripwire); (2) the harness is a detection net, not prevention (`audit-harness.md:31`) — Probe H
and the KERNEL_SPLIT_FALLBACK guard are the prevention-side additions; (3) registry curation is
operator-gated by design — nothing in Phase 0a executes without the rule-by-rule sign-off;
(4) INS-363's source-file cleanup (326KB registry) is tracked in Phase 3 but its boot effect is
fully realized in Phase 0a — the two must not be conflated in savings claims.

---

## §3 v3 consolidation — D-278 final execution plan (sole-owner mandate, S202)

Adopted in the S202 operator session; boot-context ownership is handed to this workstream
end-to-end as **D-278**. **This section supersedes the §2 phase table as the execution vehicle** —
consolidated into TWO parallel briefs (one per repo touched: prism-mcp-server, prism-framework —
the daemon's hard boundary), with the phase gates preserved as merge/flip gates.

**Operator-pinned constraints (fleet-wide per INS-340, zero fidelity loss):**
1. **GLM-5.2 offload is LIVE on all three synthesis sites** (`LLM_ROUTING_OPENROUTER_SITES=
   synthesis_draft,synthesis_pdu,synthesis_brief`). The input-truncation fidelity fix ships as
   first-class server work (s202b T9 a–d): trimmed inputs annotated in-prompt, true sizes passed as
   metadata, a server-stamped trim-provenance footer on generated artifacts, and a
   `SYNTHESIS_INPUT_TRUNCATED` diagnostic — the S202 incident (a brief citing a truncated ~21KB
   glossary view as the real 82KB file) becomes classifiable on every provider.
2. **Refined D-277/INS-370 gate** (s202c T5, new `modules/synthesis-quality-gate.md`, fleet-wide):
   only genuine model drift (invented facts contradicting merged reality) trips the
   `synthesis_brief` kill-switch; input-truncation artifacts (faithful synthesis of an incomplete
   input) are logged and fed to fix #1 — never treated as drift.
3. **Irreducible interrupt-class rules stay kernel-resident:** Rule 9, the INS-40/INS-304 verify
   posture, Rule 4 guardrails/eliminated-check, brevity/posture — pinned as Band 1 in the kernel
   spec and enforced by the mandate-preservation table (module placement = spec violation).

Two design upgrades carried from the S202 review:

**(a) Three-band rule classification (P-2 taken to its end-state).** Band 1 — always-loaded kernel:
every-response behaviors (Rule 9, posture/brevity, interaction rules) AND interrupt-class rules that
fire when the model does not know it needs them (guardrails, verify-before-assert) — irreducible in
*presence*, aggressively editable in *length*: kernel budget **≤18KB (~5K tok)**, below §1's committed
~26KB, achieved by cutting rationale/history prose while preserving every ⛔ mandate verbatim (a
mandate-preservation table is a merge gate). Band 2 — event-triggered modules behind imperative
kernel trigger lines (dispatch, ingest, finalize — the three production-proven lazy-load precedents
generalized). Band 3 — reference/manifest (P-1).

**(b) `rules_hint` — the server as second trigger mechanism.** The stateless server sees every tool
call; matching calls carry a ≤120 B additive hint field (push/patch under `.prism/ingest/` → "load
the ingest module first"; `cc_dispatch` → channel-discipline pointer). This converts part of Band 1's
unknown-unknown risk into a known prompt delivered exactly at the moment of relevance, for bytes paid
only when relevant — the prevention-side complement to the harness's detection-side Probe H.

**The two briefs (queued on the respective `briefs` branches, `parallel: true`, no execution-time
coupling — s202c is written server-generation-tolerant per the template's existing "if absent, skip"
pattern):**

| Brief | Repo | Scope | Boot effect (est) |
|---|---|---|---|
| `brief-s202b-boot-lean-server-bundle` | prism-mcp-server | P-1 manifest + `BOOT_INDEX_MODE`; `rules_hint`; P-3 digest-dedup + item-budget warn; P-4 `PREFETCH_MODE`; P-6a SVG knob; P-2 kernel handshake guard; **F-1 finalize compose-offload** (GLM composes complete validated finalization files; chat approves a ≤1.5KB digest — supersedes the INS-178 wall on the happy path); CS-2 size contract; **T9 truncation-fidelity fix a–d** (constraint 1: annotations + true-size metadata + server-stamped trim-provenance footer + `SYNTHESIS_INPUT_TRUNCATED` diagnostic) | −6.5 to −7.5K tok/boot at full flip, plus ~1.5K chat-output tok saved per finalize (F-1: 75–150K tok/mo) |
| `brief-s202c-kernel-split-v3` | prism-framework | Template v3.0.0: ≤18KB Band-1 kernel + `modules/document-ingest.md` + CC-discipline body merged into `reference/trigger-channel.md` + deferred category tool-searches + `Kernel-Manifest` handshake + monolith archived for rollback + **T5 `modules/synthesis-quality-gate.md`** (constraint 2: drift-vs-artifact classification; only drift trips the kill-switch) | −7.0 to −7.5K tok/boot (+~1.6K post-boot on non-dispatch boots) |

**Registry curation (former brief-s202d) — returned to chat-session ownership (INS-69: living
documents are updated by exactly one actor; the claude.ai session owns the prism project's docs).
Dequeued from the prism queue before dispatch. The measured curation checklist from audit §B.2, for
chat-side execution via `prism_patch`/registry edit (worth −3.4 to −3.7K tok/boot):** retire
INS-319 (superseded by D-267) / INS-230 (superseded by the template CC mandate) / INS-354
(template-ingest duplicate) — archive with full bodies, never delete; demote INS-178→B(finalize),
INS-187→B(credentials), INS-324→B(trigger), INS-340→B(framework, protocol); trim INS-226/193/260
to procedure-only (D-47 contract); operator-decide: INS-291/302/318 (template duplicates).
Verification: parser round-trip via the server's `extractStandingRules` — expect A=10, B=90, C=16,
zero ids lost.

**Merge/flip sequence (the surviving phase gates):** s202b merges on green CI + PR review
(additive/env-defaulted). s202c merges after its mandate-preservation table review; its fidelity
gate is the §0.6 harness run (Probes B/C/D/F/G + new Probe H, S157/S177 anchors) over the following
sessions, with same-day `git revert` (template-only, 5-min cache) as rollback.
`BOOT_INDEX_MODE=compact` flips after s202c is live + one soak session. `synthesis_brief` is
ALREADY live on GLM (operator flip, S202); the first fresh brief after s202b deploys gets the
refined INS-370 pass using the new trim-provenance footer (drift → kill-switch; artifact → log +
pipeline fix, per the s202c gate module). **PR/merge verification protocol (D-278):** each brief is
confirmed via the Trigger daemon state file's git fields — `state/<repo>.json` `pr_number`,
`branch`, `merge_commit`, and `post_merge.actions_completed`; `status: merged` alone is not
accepted as proof.

**End-state arithmetic (revises the §2 table; the Tier-A line assumes the chat-owned curation
checklist above is executed):** kernel ~5.1K tok (18KB) + Tier-A 10 trimmed
rules ~3.3K + manifest ~1.3K + brief (RF+QA, digest-deduped) ~1.9K + handoff fields (item-budgeted)
~2.3K + work loop 0.9K + banner 1.1K (0.35K SVG-off) + prefetch ~0.25K + misc/envelope ~1.4K ≈
**bootstrap ~11.6-12.4K tok** (vs 33.9K measured) — at or below the 12–15K target band's floor.
First exchange ≈ 11.6-12.4K + ~5K platform + ~0.9K single boot search + ~4.3K sidecar (unchanged,
PRISMA-owned) + ~0.7K Rule 2 + ~1.5K opening ≈ **~24-25K ≈ 12-12.5% of 200K**, roughly half of
today's measured 24.4% and a third of the observed worst case.

<!-- EOF: s202-refactor-proposals.md -->
