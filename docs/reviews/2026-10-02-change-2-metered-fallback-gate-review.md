# Review packet: Change-2 option (a) - metered synthesis fallback gated off by default

- Date: 2026-10-02. PRISM Session 212 of the `prism` project (Claude Code, Fable 5.1 host).
- Branch: `claude/S212-metered-fallback-gate`, base `origin/main` `db278aa`.
- Tier: A (spend, production behavior). One independent cross-model review before merge. The plan is the PR description.
- Writer: Claude Sonnet 5.5 worker at medium effort in an isolated worktree, briefed and verified by the host.
- Reviewer: Codex `gpt-6-astra` at high effort, read-only sandbox.

## Decision being implemented

Change-2 had been an open operator decision since Session 209. On 2026-10-02 the operator delegated it to the session's recommendation, option (a): gate the dormant metered fallback behind an env flag that defaults OFF. It is reversible by setting `SYNTHESIS_METERED_FALLBACK=true`.

## Subject

- `src/ai/client.ts`: in `synthesizeChain`, when `cc_subprocess` fails and the flag is off, log `SYNTHESIS_METERED_FALLBACK_BLOCKED` and return the subprocess failure. No Messages API call. Flag on: the previous path, unchanged.
- `src/config.ts`: `resolveSynthesisMeteredFallback(env)`, read at call time; `SERVER_VERSION` 4.15.4.
- Tests: six new cases in `src/ai/__tests__/client-routing.test.ts`; three existing fallback tests now set the flag explicitly.
- Docs: `CLAUDE.md` env table row and version strings, `CHANGELOG.md` 4.15.4, `docs/model-bump.md` addendum.

Not changed: the directly configured `messages_api` transport, the provider (OpenRouter) hop, `cc_dispatch`, `src/models.ts`, `src/ai/cc-subprocess.ts`, `AGENTS.md`, the harness-kit-managed block.

## Review: APPROVE, no blockers

1. Default-off is real: the early return precedes both `callMessagesApi` sites, and a provider-hop failure falls into the same guarded branch, so there is no bypass when a call-site resolves to `cc_subprocess`.
2. Flag-on behavior is identical to `origin/main`.
3. Chain state when blocked is truthful: transport `cc_subprocess`, routed model, `fallback_used` untouched. Brief and PDU failures surface as `SYNTHESIS_FAILED`; the fallback counter is not inflated.
4. Callers handle the failure: finalize draft returns an explicit failure with manual-composition guidance; brief and PDU exit before publication; `prism_synthesize` reports background status; bootstrap only observes logs.
5. Resolver contract and call-time read confirmed.
6. Tests assert zero Messages API calls with the flag unset and the old behavior with it set; no assertion was weakened or deleted.
7. Docs and version consistent; nothing changed in the excluded files.
8. No credential value in the diff.

What stays metered or paid, by design and unchanged: an explicitly configured `messages_api` transport, legacy calls with no call-site, a configured provider hop, and the retry itself when the flag is set to on.

Non-blocking notes:

1. A blocked draft is not surfaced by bootstrap's observation extractor (brief and PDU are, through `SYNTHESIS_FAILED`). The caller still gets an explicit failure and `DRAFT_FAILED` is emitted. Follow-up: a distinct blocked-attempt observation.
2. A stale source comment described the fallback as unconditional. Fixed before merge.
3. Optional extra coverage: blocked `LLM_CALL` fields, and provider failure followed by subprocess failure. Follow-up.

## Host verification

- The worker's commit exists (`89fbc68`); its diff touches nine files and none of the excluded ones; the kit-managed block is byte-identical.
- Re-run by the host on that commit and again after the comment fix: `npm test` 177 files passed, 1 skipped; 2427 tests passed, 6 skipped (baseline before the change: 2421 passed, 6 skipped). `npx tsc --noEmit` exit 0. `npm run lint` clean.
- Not verified: the flag against a live `cc_subprocess` failure on Railway. The gate was exercised through mocked unit tests only.

## Rollback

Set `SYNTHESIS_METERED_FALLBACK=true` on Railway (restores the retry, no deploy), or revert the PR.
