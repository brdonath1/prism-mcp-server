# Live Multi-Provider Routing Implementation Review

Date: 2026-06-25

Repository: `brdonath1/prism-mcp-server`
Branch: `codex/live-multi-provider-routing`
Base: `origin/main` at merged PR #94 commit `8cdc489 Add dormant model route resolver (#94)`

## Scope

This packet covers the MCP server change from dormant model-route readiness to live non-Anthropic synthesis invocation.

Changed implementation surfaces:

- `src/llm/provider-adapters.ts`
- `src/llm/provider-registry.ts`
- `src/llm/route-status.ts`
- `src/llm/route-types.ts`
- `src/llm/routing-policy.ts`
- `src/ai/client.ts`
- `src/ai/synthesis-tracker.ts`
- `src/config.ts`

Changed tests and documentation:

- `src/llm/__tests__/provider-adapters.test.ts`
- `src/llm/__tests__/provider-registry.test.ts`
- `src/llm/__tests__/route-status.test.ts`
- `src/llm/__tests__/routing-policy.test.ts`
- `src/ai/__tests__/client-routing.test.ts`
- `tests/brief-466-docs-version.test.ts`
- `.env.example`
- `CLAUDE.md`
- `docs/model-bump.md`
- `package.json`
- `package-lock.json`

No CI, Trigger, deployment manifest, active Claude.ai Project setting, MCP client configuration, or credential file is changed by this branch.

## Intended Effect

- Invoke live provider adapters for non-Anthropic synthesis routes when routing is explicitly enabled, dry-run is disabled, the provider is explicitly allowed, and the provider credential env var is present.
- Support OpenAI Responses, xAI Responses, DeepSeek chat completions, Perplexity chat completions, and Gemini `generateContent`.
- Preserve `cc_dispatch` as Claude Code OAuth only.
- Keep provider failures sanitized and fall back to the existing Anthropic synthesis path.
- Report `prism_status.llm_routing.status="live"` only when at least one synthesis route is actually invocable.
- Bump the MCP server version to `4.9.0`.

## Protected Boundary

This implementation is a production behavior change once merged and deployed with live routing variables. Brian authorized production MCP behavior changes for this session.

The branch still does not perform:

- Credential creation, rotation, or value logging.
- Active Claude.ai Project setting changes.
- MCP client installation, OAuth consent, or client configuration mutation.
- Trigger or CI behavior changes.

Production activation after deploy is limited to non-secret Railway routing variables. Provider credential values remain environment-managed and are referenced only by env var name.

## Rollback

Rollback path:

- Revert the eventual merge commit.
- Or immediately disable runtime activation by setting `LLM_ROUTING_ENABLED=false`.
- Or return to observation-only mode by setting `LLM_ROUTING_DRY_RUN=true`.
- Or remove non-Anthropic providers from `LLM_ROUTING_ALLOWED_PROVIDERS`.

Any of these paths returns synthesis to the existing Anthropic fallback behavior while preserving `cc_dispatch` as Claude Code OAuth.

## Adversarial Review

Security and boundary review: PASS.

- Verified provider HTTP failures return status-only errors and do not log provider payload text.
- Verified Gemini auth uses `x-goog-api-key` instead of query-string credentials.
- Verified non-Anthropic live routing requires explicit `LLM_ROUTING_ALLOWED_PROVIDERS`.
- Verified route status requires an actually invocable synthesis route before reporting live.
- Verified `cc_dispatch` remains forced to Claude Code OAuth.

Provider correctness review: PASS.

- Verified non-completed Responses payloads fail before returning content.
- Verified non-`stop` OpenAI-compatible chat finishes fail before returning content.
- Verified non-`STOP` Gemini finishes fail before returning content.
- Verified `AbortError`, `abort`, and `timeout` provider exceptions classify as `TIMEOUT`.
- Residual non-blocking hardening note: absent terminal metadata with present content is accepted because official non-streaming provider response shapes include terminal fields.

Production readiness review: PASS.

- Verified fail-closed provider allow-list behavior.
- Verified status does not overclaim live activation.
- Verified Perplexity, xAI, Gemini, DeepSeek, and OpenAI adapter paths have targeted tests.
- Verified Gemini credentials are not placed in URLs.
- Noted that new adapter files must be staged for the PR.

No unresolved model disagreement remains in this packet.

## Verification

Main-agent verification on this branch:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- `npm test -- --reporter=dot`: 137 files passed, 1 skipped; 1619 tests passed, 5 skipped.
- `git diff --check`: passed.
- Added-line secret-shaped scan: no findings.

Fresh verification must be rerun after any later edit before commit, PR, merge, or production activation.
