/**
 * brief-s5 §6 — CI drift check on the API column ONLY.
 *
 * The `api` column is the one column with a machine-readable authority:
 * `client.models.retrieve(id).max_input_tokens`. This test asserts every api
 * cell in MODEL_CAPABILITIES matches it for reachable IDs, so the registry
 * fails LOUDLY when Anthropic ships a change instead of drifting silently for
 * three model generations (the S5 failure).
 *
 * The `chat` and `claude_code` columns are NOT checked here — there is no
 * endpoint to query, they are hand-maintained, and querying the API for them is
 * precisely the cross-surface substitution this brief exists to prevent. What
 * this test DOES give those columns for free is a drift SIGNAL: when an api
 * cell moves and the same model's chat cell has not been re-verified since, the
 * failure message flags the chat cell for review.
 *
 * WHERE IT RUNS. This needs a live ANTHROPIC_API_KEY, which ci.yml's test job
 * deliberately does not have (and tests/setup.ts injects a dummy value). It is
 * therefore self-skipping by default and wired into .github/workflows/
 * model-freshness.yml, which already holds the secret. Run it locally with a
 * real key via: ANTHROPIC_API_KEY=sk-ant-... npx vitest run
 * tests/model-capabilities-api-drift.test.ts
 */

import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { MODEL_CAPABILITIES } from "../src/models.js";

/**
 * A real key, not the tests/setup.ts dummy. Gating on shape rather than mere
 * presence matters: setup.ts sets ANTHROPIC_API_KEY unconditionally, so a
 * presence check would make this test fire against a fake credential on every
 * `npm test` and fail for the wrong reason.
 */
const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
const hasLiveKey = apiKey.startsWith("sk-ant-");

/** api cells, as (registry key → canonical API model id) pairs. */
const apiCells = Object.entries(MODEL_CAPABILITIES)
  .filter(([, capability]) => capability.api)
  .map(([key, capability]) => ({
    key,
    modelId: `claude-${key}`,
    expected: capability.api!.tokens,
    apiAsOf: capability.api!.as_of,
    chatAsOf: capability.chat?.as_of ?? null,
  }));

describe.skipIf(!hasLiveKey)("API column drift check (live Anthropic model metadata)", () => {
  it(
    "every api cell matches client.models.retrieve(id).max_input_tokens for reachable IDs",
    { timeout: 60_000 },
    async () => {
      const client = new Anthropic({ apiKey });

      const results = await Promise.all(
        apiCells.map(async (cell) => {
          try {
            const info = await client.models.retrieve(cell.modelId);
            return { cell, live: info.max_input_tokens ?? null, error: null as string | null };
          } catch (error) {
            const status = (error as { status?: number }).status;
            const message = error instanceof Error ? error.message : String(error);
            // 404 = this key cannot see the model (unreleased / not entitled).
            // The brief scopes the check to "reachable IDs", so that is a skip,
            // not a failure. Anything else (401/403/429/5xx) is a real problem
            // and must surface rather than pass silently.
            return {
              cell,
              live: null,
              error: status === 404 ? null : `${cell.modelId}: HTTP ${status ?? "?"} — ${message}`,
              unreachable: status === 404,
            };
          }
        }),
      );

      const transportErrors = results.map((r) => r.error).filter((e): e is string => !!e);
      expect(transportErrors, "model metadata could not be fetched").toEqual([]);

      const unreachable = results.filter((r) => (r as { unreachable?: boolean }).unreachable);
      const noFigure = results.filter((r) => !r.error && !(r as { unreachable?: boolean }).unreachable && r.live === null);
      const checked = results.filter((r) => r.live !== null);

      const drift = checked
        .filter((r) => r.live !== r.cell.expected)
        .map((r) => {
          // Free drift signal (brief §6): an api move on a model whose chat
          // cell has not been re-verified since means the chat cell is now
          // suspect too — flag it, but never auto-correct it (Guardrail: API
          // evidence must not promote a chat cell).
          const chatSuspect =
            r.cell.chatAsOf !== null && r.cell.chatAsOf <= r.cell.apiAsOf
              ? ` — ALSO re-verify the chat cell for "${r.cell.key}" (as_of ${r.cell.chatAsOf}, not re-checked since the api cell); do NOT copy this api figure into it`
              : "";
          return `${r.cell.modelId}: registry says ${r.cell.expected}, API says ${r.live}${chatSuspect}`;
        });

      if (unreachable.length || noFigure.length) {
        console.log(
          `[api-drift] checked ${checked.length}/${apiCells.length} cells; ` +
            `unreachable (404): ${unreachable.map((r) => r.cell.modelId).join(", ") || "none"}; ` +
            `no max_input_tokens reported: ${noFigure.map((r) => r.cell.modelId).join(", ") || "none"}`,
        );
      }

      expect(drift, "API column has drifted from live model metadata").toEqual([]);
      // A run where nothing was reachable is not a passing run — it means the
      // key or the id naming changed and the check has quietly stopped working.
      expect(checked.length, "no api cells were reachable — the check is not actually running").toBeGreaterThan(0);
    },
  );
});

describe("API column drift check — gating", () => {
  it("self-skips without a live key so `npm test` stays green in ci.yml", () => {
    expect(typeof hasLiveKey).toBe("boolean");
    // The dummy from tests/setup.ts must never be treated as live.
    expect("test-dummy-anthropic".startsWith("sk-ant-")).toBe(false);
  });

  it("covers every api cell in the registry", () => {
    const withApi = Object.values(MODEL_CAPABILITIES).filter((c) => c.api).length;
    expect(apiCells).toHaveLength(withApi);
    expect(apiCells.length).toBeGreaterThan(0);
  });
});
