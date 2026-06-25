# Dormant Model-Route Resolver Implementation Review

Date: 2026-06-25

Repository: `brdonath1/prism-mcp-server`
Branch: `codex/dormant-model-route-resolver`
Base: `codex/fable-deprecation-deepseek-routing` at PR #92 head

## Scope

This packet covers the dormant model-route resolver and multi-LLM routing activation-readiness work in the MCP server.

Changed implementation surfaces:

- `src/llm/*`
- `src/ai/client.ts`
- `src/claude-code/client.ts`
- `src/tools/status.ts`

Changed tests and documentation:

- `src/ai/__tests__/client-routing.test.ts`
- `tests/cc-dispatch-route-observation.test.ts`
- `tests/status-archives.test.ts`
- `tests/brief-466-docs-version.test.ts`
- `.env.example`
- `CLAUDE.md`
- `docs/model-bump.md`

## Intended Effect

- Add a provider registry and deterministic route resolver for dormant routing decisions.
- Expose sanitized route observations through `LLM_ROUTE_OBSERVATION` logs.
- Expose sanitized `prism_status.llm_routing` readiness metadata.
- Preserve existing Anthropic Messages API and Claude Code subprocess execution paths.
- Keep every route decision non-live: `liveInvocationAllowed` remains `false`.

## Protected Boundary

This implementation does not authorize or perform:

- Credential creation, rotation, validation, or value logging.
- Railway variable reads or writes.
- Live non-Anthropic provider invocation.
- MCP client behavior mutation.
- Trigger, CI, deployment, or production behavior changes.
- Active Claude.ai Project setting changes.

`CLAUDE.md` changes are repo-visible instruction/documentation updates only. Live Claude.ai Project settings remain operator-only.

## Rollback

Rollback is a normal git revert of this branch or eventual merge commit. Since no live routing or Railway variable changes are performed, disabling `LLM_ROUTING_ENABLED` or reverting this code returns the service to the prior Anthropic-only behavior.

## Adversarial Review

Boundary safety review: PASS.

- Verified non-Anthropic routing remains dormant and `liveInvocationAllowed` is literal `false`.
- Verified protected-boundary negative control blocks routing.
- Verified logs/status expose names and non-secret labels only.
- Verified existing live call paths remain Anthropic Messages API and Claude Code.
- Residual risk: merge/deploy of this server code remains the production boundary.

Routing correctness review: PASS.

- Verified dry-run/provider overrides do not change live Messages API or Claude Code dispatch model/env behavior.
- Verified env precedence is preserved by existing `resolveCallSiteRouting()` and dispatch defaults.
- Non-blocking activation-readiness follow-up: align the PRISM readiness manifest with `LLM_ROUTING_CC_DISPATCH_PROVIDER` before Railway routing-variable work or activation.

Test and docs adequacy review: PASS.

- Verified tests cover provider registry, route policy, route status, route observation, docs placeholders, and status exposure.
- Reviewer noted fleet status coverage as a non-blocking gap; this was addressed by adding a multi-project `prism_status.llm_routing` assertion.

No unresolved model disagreement remains in this packet. The MCP server worktree does not contain a `.metaswarm` adapter surface, so local cross-model adapter invocation was unavailable here; the implementation received fresh adversarial sub-agent review instead.

## Verification

Final verification after the test-coverage patch:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- Secret-shaped scan over changed docs/runtime/test surfaces: no secret values found; remaining hits are negative assertions.
- `npm test -- --reporter=dot`: 136 files passed, 1 skipped; 1601 tests passed, 5 skipped.

## Activation Readiness Boundary

This branch is readiness-only. Live multi-provider activation requires a later target-specific reviewed plan, explicit provider/transport implementation, sanitized verification evidence, rollback path, and no unresolved model disagreement.

## Restack Addendum

Date: 2026-06-25

Restacked branch: `codex/dormant-route-resolver-main`

Base: `origin/main` at `490c77baa7d85dd36b1664523de1592ac25b9ce9`, the merged PR #92 production commit.

Additional change after the original packet:

- `.env.example` now documents `LLM_ROUTING_CC_DISPATCH_PROVIDER=anthropic`.
- `tests/brief-466-docs-version.test.ts` now asserts the cc_dispatch routing placeholder stays documented.

Fresh adversarial review after restack:

- Boundary Safety: PASS. Reviewer verified `liveInvocationAllowed` is type-locked/returned as `false`, route observation does not alter synthesis or Claude Code execution, status/log fields expose names only, and the changed file set contains no Railway manifest/config, Trigger, CI, deployment config, MCP client config, package/script, credential, active Claude.ai setting, or live provider invocation changes.
- Routing Correctness: PASS. Reviewer verified dormant decisions remain non-live, observation does not feed execution, Messages API and Claude Code defaults are preserved, and candidate routing env vars include `LLM_ROUTING_CC_DISPATCH_PROVIDER` in code/docs/status.
- Verification Evidence: PASS. Reviewer verified resolver/status/cc_dispatch/docs tests cover the intended readiness-only behavior, sanitized status exposure, and docs/env placeholders. Reviewer reran `npm run typecheck`, `npm run lint`, `git diff --check origin/main...HEAD`, `npm test -- --reporter=dot`, and an added-line secret-shaped scan with 0 findings.

Main-agent final verification on restacked branch before PR:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- `git diff --check origin/main...HEAD`: passed.
- `npm test -- --reporter=dot`: 136 files passed, 1 skipped; 1601 tests passed, 5 skipped.
- Added-line secret-shaped scan over 968 added lines: 0 findings.

No unresolved model disagreement remains after the restack review.
