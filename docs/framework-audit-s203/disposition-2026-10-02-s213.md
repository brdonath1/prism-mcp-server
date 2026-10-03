# S203 audit backlog disposition, 2026-10-02 (PRISM Session 213)

Disposition of the S203 framework-audit backlog (`recommendations.md`, mirrored by `backlog.json`), published next to the audit so the D-289 "tracked by pointer" rule points at current state.

Method: each recommendation's `verify` field was checked against origin/main at prism-mcp-server 2ac3eb99, prism-framework ae3cfacb, prism 44799d82 and the trigger repo. Produced by a Sonnet 5.5 worker for PRISM Session 213. Host-verified counts: DONE 51, PARTIAL 8, NOT DONE 1, BLOCKED-KERNEL 6, HUMAN 2, OBSOLETE 2.

Correction applied by the host: D-KERNEL-REDERIVE is discharged (see the Deferred line). `backlog.json` is unchanged.

| id | pri | repo | status | evidence | remaining work |
|---|---|---|---|---|---|
| R1 | P0 | mcp-server | DONE | host-established; bootstrap.ts client_model/client_surface; bootstrap-s205a-guards green | none |
| R20 | P1 | mcp-server | DONE | auth-middleware.test.ts:211 (gate on, 401), :255-260 XFF; AUTH_REQUIRE_BEARER config.ts:884; 14 test files 207/207 green | gate default/Railway value not checked |
| R12 | P1 | mcp-server | DONE | finalize-use-draft-files.test.ts:236 enumerates all return sites; green | none |
| R11 | P1 | mcp-server | DONE | finalize_render_contract x12 in finalize.ts (e.g. :2195,:2309); same test | none |
| R22 | P1 | mcp-server | DONE | finalize-compose-offload.test.ts:426, bridge test :332; finalize.ts:652 compose_threw, :2280 | none |
| R21 | P1 | mcp-server | DONE | log-decision.ts:26-46, log-insight.ts:60-80 non-404 => unverified, no write | none |
| R57 | P1 | mcp-server | DONE | log-decision.ts:141 normalizeDecisionStatus null => "Invalid decision status" reject | none |
| R23 | P1 | mcp-server | DONE | BOOTSTRAP_WALL_CLOCK_DEADLINE_MS config.ts:557; read-tool-deadlines R23 test green | none |
| R30 | P2 | mcp-server | DONE | read-path-degraded.test.ts:113 green; status.ts:232 | none |
| R28 | P2 | mcp-server | DONE | push.ts:40 files .min(1) | none |
| R29 | P2 | mcp-server | DONE | bootstrap.ts:1036-1091 ambiguous state; slug-resolution.test.ts green | none |
| R32 | P2 | mcp-server | DONE | finalize-draft-timeout.test.ts:163-179 green | none |
| R24 | P2 | mcp-server | DONE | GITHUB_RETRY_BUDGET_MS; github-client-timeouts.test.ts:155 green | none |
| R25 | P2 | mcp-server | DONE | safe-mutation.test.ts:416 green; structural check safe-mutation.ts:188 | none |
| R26 | P2 | mcp-server | DONE | index.ts:250 registerShutdownHandlers onDrain shutdownReaper | none |
| R27 | P2 | mcp-server | DONE | src/tools/finalize/{audit,banner}.ts exist; finalize tests green | none |
| R9 | P2 | mcp-server | DONE | bootstrap-s205a-guards.test.ts:193-243 green | none |
| R17 | P2 | mcp-server | DONE | tool-registry.ts:41 RENDER_SURFACE_TOOLS; guards test :276 | client-side render-fail needs live boot (not run) |
| R18 | P2 | mcp-server | DONE | banner.ts:107,238,332 nullable docCount | none |
| R19 | P2 | mcp-server | DONE | banner.ts:437 BANNER_DELIVERABLES_TRUNCATED; finalize-banner-caps green | none |
| R70 | P2 | mcp-server | DONE | HANDOFF_ITEM_BUDGET_BYTES default 800 config.ts:211 | live boot count (<=1 warning) not run |
| R-DOCS-MS | P2 | mcp-server | DONE | model-bump.md MODEL_CAPABILITIES row + HELD note; pricing.ts has deepseek-v4-pro:79, sonar-pro:33; CLAUDE.md:345 trigger path; env rows :112,:114 | none |
| R75 | P3 | mcp-server | DONE | standing-rules.ts:209 anchored exclusion; standing-rules.test.ts R75 green | none |
| R31 | P3 | mcp-server | DONE | client.ts:658-689 short page breaks, :717,:859 body cancel | none |
| R10 | P0 | framework | DONE | core-template-mcp.md:71-75 RENDER OUTCOME branch + fenced name; rules-session-end.md:67 inline fallback | live Probe F soak not run |
| R4 | P1 | framework | DONE | core-template.md v2.34.2 Opus 5 row :80/:267, floor disclosure :273; test :208-209; CHANGELOG 2.30.0 | none |
| R3 | P1 | framework | DONE | context-economy.md:123-129 enumeration; rule9 test :249-250 pins it | kernel pointer not byte-checked |
| R15 | P1 | framework | PARTIAL | D-263 rationale only in reference/context-economy.md; 0 hits in core-template-mcp.md | kernel rationale + remedial clause needs kernel bytes |
| R13 | P1 | framework | DONE | audit-harness.md header v5, v4->v5 note :173 | none |
| R14 | P1 | framework | NOT DONE | Probe H authored (:115) but prism audit-trail.md rows stop at S180 (all v3) | run harness over S181-S203, append rows |
| R-PROBE-W | P1 | framework | PARTIAL | audit-harness.md:81-87 columns+synthetic example; rule9 test has 0 rule9_window/mis-scaled assertions | add test assertions pinning the two columns |
| R33 | P1 | framework | DONE | rules-session-end.md:22-28 use_draft_files/draft_files | live compose finalize not verified |
| R35 | P1 | framework | DONE | core-template-mcp.md:54 session_state_manifest (1 hit) | none |
| R34 | P1 | framework | BLOCKED-KERNEL | no identity segment in Running: grammar (:18); no mutation-freeze clause | needs kernel bytes; PI-13 relaxation alternative |
| R16 | P2 | framework | DONE | banner-spec.md v4.3, Note 2 :190 branch-conditional, README :33-34 4.3 | none |
| R38 | P2 | framework | DONE | core-template-mcp.md:56 four-category line | none |
| R44 | P2 | framework | DONE | no "200K default" in context-economy.md or core-template.md | none |
| R7 | P2 | framework | BLOCKED-KERNEL | kernel :123 still "flag the mismatch" | narrow wording; kernel bytes |
| R8 | P2 | framework | BLOCKED-KERNEL | D-227 / provenance-tagged context_window phrase absent from kernel | kernel clause + rule9 test pin |
| R36 | P2 | framework | DONE | context-economy.md:19-24 provenance (D-279, D-287, D-293, 19,000 B) | none |
| R37 | P2 | framework | PARTIAL | mcp-tool-surface.md 32 tools, load-trigger header :3; no kernel Band-3 trigger row | kernel row needs bytes |
| R39 | P2 | framework | PARTIAL | README: modules "(12)" vs 13 files; codex-lane-enrollment.md absent; reference (17)=17 | fix count, add missing module row |
| R40 | P2 | framework | PARTIAL | rows only in core-template.md:412-413 (fallback); 0 in kernel | kernel rows need bytes |
| R41 | P2 | framework | BLOCKED-KERNEL | no commit-prefixes/claude-code-config/mcp-tool-surface trigger rows in kernel | Band-3 trigger table; kernel bytes |
| R42 | P2 | framework | BLOCKED-KERNEL | kernel :43 "load reference/trigger-channel.md" names no section; Rule 6 :101 no exception | kernel wording |
| R43 | P2 | framework | BLOCKED-KERNEL | no operator-utterance finalize/audit-first line in kernel | kernel line |
| R45 | P0 | trigger | DONE | worker.ts:381 modelFlag; preflight.ts:40,305 model gate; schema.ts default_model | pin armed only if default_model set (machine-setup has fable) |
| R46 | P1 | trigger | DONE | frontmatter.ts:40-42 xhigh; default-effort.test.ts:55 | none |
| R47 | P1 | trigger | DONE | types/index.ts:234-251 R47 fields; worker.ts:472 | dispatch info-line text not inspected |
| R48 | P1 | trigger | DONE | poller/index.ts:437-469 gated retry log | none |
| R49 | P1 | trigger | DONE | poller/index.ts:352 once-per-lifetime; state/manager.ts:58,574 buildRetryFrontmatter(defaultModel) | none |
| R51 | P1 | trigger | DONE | orchestrator.ts:551 24h re-notify; status.ts:58,98 renderDetectionDead | none |
| R50 | P1 | trigger | DONE | default-effort.ts R50 header; format.ts:91 abandoned_pane_dead hard ceiling | heartbeat log line not inspected |
| R55 | P2 | trigger | DONE | clone-sync.ts:35 sync only when HEAD on main | none |
| R52 | P2 | trigger | DONE | poller/index.ts:628 direct children only | none |
| R54 | P2 | trigger | DONE | post-merge.ts:23 retired; .prism/trigger.yaml:33 | none |
| R53 | P2 | trigger | PARTIAL | trigger.config.yaml clean; machine-setup main tmpl:136-140 still has branch_strategy/intra_project_parallel/max_parallel_briefs/worktree_dir | remove dead quartet in machine-setup template |
| R56 | P3 | trigger | DONE | index.ts:237, status.ts:62 build identity | none |
| R-TRIG-PANE | P3 | trigger | DONE | pane-reaper.ts:31-47 startPeriodicPaneReaper (hourly); index.ts:62,624 | none |
| R58 | P1 | prism | DONE | handoff.md v222, Template 3.6.2, one settings block, Next Steps non-merged | none |
| R59 | P1 | prism | PARTIAL | session-log.md holds S207-212 only; S202-206 in session-log-archive.md (order non-monotonic), S201 absent | S201 entry; literal grep check obsolete |
| R57d | P1 | prism | DONE | _INDEX.md only D-282 text mentions DECIDED; 0 DECIDED rows | none |
| R65 | P1 | prism | OBSOLETE | superseded by D-284 (_INDEX.md) routing revert to Anthropic OAuth | none |
| R60 | P2 | prism | DONE | standing-rules.md 46,720 B < 150,000 tripwire (config.ts:304) | none |
| R61 | P2 | prism | DONE | glossary.md has kernel/band/session_state_manifest/D-278 rows (:183-193) | listed-term list not re-derived (spot check) |
| R63 | P2 | prism | DONE | KI-26 names sanitizeContent(); wired in log-decision.ts:277, log-insight.ts:293 | none |
| R64 | P3 | prism | PARTIAL | _INDEX.md:4 says 245 rows (126/81/27...); actual 247 (127 ops, 28 opt) | refresh summary counts |
| R2 | P1 | operator-env | HUMAN | Railway DEFAULT_CONTEXT_WINDOW_TOKENS not readable here; code default 500K config.ts:100 | operator clears env; live boot check |
| R-ENV-FLIP | P2 | operator-env | OBSOLETE | config.ts:73-76 BOOT_INDEX_MODE default flipped to compact (4.14.2, PR #124) | none |
| R-ENV-MAST | P2 | operator-env | HUMAN | BOOT_MASTHEAD_SVG knob config.ts:224; R10 text fallback lessens need | operator env decision |

Deferred: D-FINALIZE-SESSIONLOG-GUARD DONE (finalize/banner.ts:407 FINALIZE_MISSING_SESSION_LOG); D-FINALIZE-SPLIT partial (2 of 6 extractions, finalize.ts still 2892 lines); D-KERNEL-REDERIVE DISCHARGED by PRISM decision D-295 (S213, 2026-10-02: 21,400 B settled as the kernel ceiling under the measured-operative-kernel criterion; window-share derivation rejected; the "README says re-derivation still owed" note is stale as of that decision); D-STANDING-RULES-LIFECYCLE open; D-FALLBACK-SPLIT undecided (README calls fallback "live, not frozen").

## (a) Counts
DONE 51 | PARTIAL 8 | NOT DONE 1 | BLOCKED-KERNEL 6 | HUMAN 2 | OBSOLETE 2 | UNVERIFIED 0 (total 70)

## (b) Implementable now (no Railway env, no kernel bytes)
- P1 R14 (M): run harness S181-S203, append audit-trail rows (needs chat history access).
- P1 R-PROBE-W (S): pin rule9_window_declared/correct + mis-scaled example in rule9 test.
- P1 R59 (S): backfill S201 session-log entry (archive holds the rest).
- P2 R39 (S): README modules count 12->13, add codex-lane-enrollment.md.
- P2 R53 (S): drop dead quartet from machine-setup trigger.config.yaml.tmpl.
- P3 R64 (S): refresh _INDEX.md domain summary (247 rows).
- P2 R37/R40 residual: only kernel-row halves remain, both bytes-blocked, so not implementable.

## (c) Discrepancies
- R59 verify (grep -c 'Session 202' session-log.md >= 1) fails on origin/main because the log was rotated; S202-206 live in the archive. S201 genuinely missing.
- R64: summary says 245 rows regenerated S212; index has 247 (D-292/D-293 added after).
- R15/R37/R40 look landed (files exist) but only in Band-3/fallback; the kernel/MCP-delivered chain lacks them.
- R-PROBE-W recorded as framework-doc done, but its test half is absent.
- R65 and R-ENV-FLIP are superseded (D-284; BOOT_INDEX_MODE default flip) and could be closed in backlog.
- D-282 text says validator PR #117 "review-pending"; the code is on origin/main (R57 reject verified).
- R53: trigger repo config clean but machine-setup template (the actual runtime source) is not.
- Unrun: framework `node --test` (working tree on another harness's branch), live-boot checks (R2/R10/R17/R70), trigger tests.
