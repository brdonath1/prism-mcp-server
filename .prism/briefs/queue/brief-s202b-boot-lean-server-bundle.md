---
model: claude-fable-5
effort: max
parallel: true
affects:
  - src/
  - tests/
---

# Brief s202b — Boot-lean server bundle + finalize compose-offload (S202)

> **Purpose:** Implement the SERVER half of the S202 boot-context refactor (operator-approved).
> Normative design: `docs/boot-context-refactor/s202-refactor-proposals.md` + `s202-boot-context-audit.md`
> + `s202-component-inventory.json` (PR #108, branch `docs/brief-s202a-boot-context-audit`; read them
> from that branch if not yet merged to main — `git show origin/docs/brief-s202a-boot-context-audit:<path>`).
> Measured baseline (verify, don't trust — INS-40): prism boot payload 119,662 B ≈ 33.9K tok;
> standing_rules_index 19,873 B (62% titles); prefetch 4,005 B; brief compact 7,145 B with the
> Project State digest duplicating `current_state`; critical_context 708 B/item avg.
> All changes are additive/env-gated so this deploys with near-zero behavior change until flips.

## Context

- The B/C index and prefetch scale with repo population, not session need (audit §B.3/§B.7).
- Finalize composition is chat-output cost (INS-178); D-275 F-1 moves composition to the GLM-served
  CS-1 site with server validation gating (est 75–150K chat-tok/mo).
- The companion briefs: s202c (framework kernel split — consumes the handshake + manifest added here,
  tolerantly) and s202d (prism registry curation). No coordination needed at execution time; this brief
  must not touch any other repo.

## Tasks

**T1 — `session_state_manifest` + compact index (P-1).** New bootstrap field:
`{ docs: [{path, sha, bytes}], rules: { total, tier_counts, index: [{id, t, topics, title60}] }, brief: { synthesized_session, sections } }`.
`title60` = title truncated at 60 chars with `…`. Env `BOOT_INDEX_MODE=full|compact` (default `full`):
`full` ships today's `standing_rules_index` unchanged PLUS the manifest (additive release, SRV-109
two-phase); `compact` ships the manifest ONLY (legacy index omitted). Expected compact saving ≈ −15.4KB.

**T2 — `rules_hint` (stateless module nudges).** Additive ≤120 B string field on: (a) `prism_push`/
`prism_patch` responses when any target path is under `.prism/ingest/` → hint to load
`modules/document-ingest.md` first; (b) `cc_dispatch` response → hint that CC-channel discipline lives
in `reference/trigger-channel.md`. Emit on every matching call (server is stateless); harmless if
already loaded.

**T3 — Brief compactor digest-dedup (P-3).** `compactIntelligenceBrief` drops the
`**Project State (compact):**` digest line (measured full duplicate of `current_state` in the same
payload); keeps FULL Risk Flags + FULL Quality Audit. Spec-coupled + `BRIEF_COMPACT_FALLBACK` guard
retained exactly as today (D-253 lesson b). Env `BRIEF_COMPACT_MODE=dedup|legacy` (default `dedup`).

**T4 — Prefetch policy (P-4).** Env `PREFETCH_MODE=opening_only|legacy` (default `opening_only`):
drop the `next_steps`-keyword auto-trigger (`bootstrap.ts:845-850`); keep opening-message keywords and
the always-prefetched pending-doc-updates entry. Cap any single summary at 1,200 B (post-SRV-74 caps
retained). Add `PREFETCH_DELIVERED` info diagnostic naming delivered files (hit-rate telemetry the
audit found missing).

**T5 — Handoff item budget (P-3/P-7).** Warn-only `HANDOFF_ITEM_OVERSIZE` diagnostic when any
Critical Context item exceeds 300 B (boot parse + finalize validation). Never reject.

**T6 — Masthead knob (P-6a).** Env `BOOT_MASTHEAD_SVG=on|off` (default `on` — D-249 is an operator
choice); `off` ships `boot_masthead_svg: null` (template fallback path is pre-built).

**T7 — Kernel handshake (P-2 server guard).** Parse optional `Kernel-Manifest:` header line from the
behavioral-rules template (comma list of required kernel section H2s). When present and any listed
section is missing from the delivered template → `KERNEL_SPLIT_DRIFT` warn diagnostic (BANNER_DRIFT
pattern, `bootstrap.ts:733-753`). Absent header = pre-kernel template, no diagnostic.

**T8 — Finalize compose-offload (F-1, the big one).** Extend the draft phase (CS-1 site, already
GLM-served): prompt emits COMPLETE finalization files — handoff.md (full HANDOFF schema), the
session-log append entry, task-queue delta — under hard size contracts (handoff ≤10KB;
critical_context ≤5 items ≤300 B each). Draft response adds `draft_files: [{path, content}]` +
`draft_summary` (≤1.5KB compact diff-style digest for chat review). `prism_finalize action=commit`
accepts `use_draft_files: true` + per-file accept/override so chat approves instead of regenerating
(supersedes the INS-178 wall for the happy path: chat output ~0.2K tok instead of ~1.7K+).
**Quality gate = fallback trigger (D-275 §4.5 pattern):** every draft file must pass the existing
server validators (handoff schema, EOF, sections) BEFORE being returned as `draft_files`; any failure
→ legacy 6-key draft response + `SYNTHESIS_PROVIDER_FALLBACK`-style warn with `fallback_reason`. Env
`FINALIZE_COMPOSE_MODE=files|legacy` (default `files`).

**T9 — Synthesis size contracts + trim annotation.** (a) CS-2 prompt: enforce the 1500–3000-tok
target as an upper bound statement; CS-3 unchanged. (b) `input-budget.ts`: trimmed inputs are
annotated `[trimmed from N KB — do not cite truncated size as a file fact]` and true byte sizes pass
as metadata — the queued INS-363-adjacent fix that unblocks the operator's env-only
`synthesis_brief` → GLM re-flip (the re-flip itself is operator/env action, NOT this brief).

**T10 — Version + tests.** `SERVER_VERSION` → `4.13.0` (config.ts + package.json). Tests: brief-465-
pattern round-trip fidelity (trimmed payload field-complete: Meta, Where We Are, index-or-manifest,
decisions, handoff sections); manifest shape + BOOT_INDEX_MODE matrix; digest-dedup + fallback;
prefetch-mode matrix + summary cap; item-budget warn; masthead knob; kernel-handshake drift; compose-
offload validation-gate matrix (valid→files, invalid→legacy fallback); trim annotation.

## Hard constraints

- This repo only. No template edits, no env VALUE reads/reproduction (names only), no Railway actions.
- No account-attestation/Step-0 section (retired by D-267).
- All new behavior env-gated with the defaults stated above; every default is chosen so a deploy
  without env changes is safe (only T3/T4/T8 change visible behavior, each with validation-gated
  fallback and env rollback).
- Every quantitative claim in the PR body carries a measurement or file:line citation (INS-40/304).
- Quality gates before PR: `npm test` (baseline 1726 passed | 5 skipped), `npx tsc --noEmit`,
  `npm run lint` — zero regressions; record counts N→M.
- Stay under 150 turns.

## Finishing up

- Branch from `main`: `feat/brief-s202b-boot-lean-server-bundle`.
- Commit prefix `prism(S202):`. PR title:
  `prism(S202): brief-s202b boot-lean server bundle + finalize compose-offload (P-1/3/4/6a/7, F-1)`.
- PR body: per-task disposition table (file:line), measured before/after `response_bytes` on the test
  fixtures + the BOOT_INDEX_MODE=compact projected delta, test counts N→M, env-knob table
  (name/default/rollback), repo HEAD SHA at start (INS-283).
- Immediately after the PR opens, self-dequeue (INS-324 §2): fetch `briefs`, delete
  `.prism/briefs/queue/brief-s202b-boot-lean-server-bundle.md`, push; 409/422 → re-fetch, retry ≤3×;
  never touch other queue files. **If the queue file is already gone (daemon may pre-remove on
  out-of-band or raced runs — S202 observed), record the daemon's removal commit SHA instead and note
  it in the PR body; do not touch `failed/`.**
- Daemon archives on merge. Operator post-merge flips (documented, not executed here):
  `BOOT_INDEX_MODE=compact` after the s202c template merge + one soak session.

<!-- EOF: brief-s202b-boot-lean-server-bundle.md -->
