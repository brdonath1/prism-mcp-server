/**
 * LLM_ROUTING_TABLE — the startup routing-table log (D-275 / brief-s196c,
 * design doc §4.8). One info line at server start printing the resolved
 * call_site→provider→model→transport for every LLM surface, via the SAME
 * resolvers production calls use (resolveRoute + resolveCallSiteRouting).
 *
 * This permanently kills the "configured but never serving" env-knob class
 * (D-275 §3.5 forensics): any inert knob is visible in one log line at every
 * deploy. Rows carry provider names, model ids, transport names, and reasons
 * only — never env values or secrets.
 */

import { resolveCallSiteRouting, type SynthesisCallSite } from "../ai/client.js";
import { CC_DISPATCH_MODEL } from "../config.js";
import { logger } from "../utils/logger.js";
import { resolveRoute } from "./routing-policy.js";
import type { LlmSurface, RoutingEnv } from "./route-types.js";

export interface RoutingTableRow {
  call_site: string;
  provider: string;
  model: string;
  transport: string;
  live: boolean;
  reason: string;
  note?: string;
}

const SYNTHESIS_TABLE_SITES: ReadonlyArray<{
  surface: LlmSurface;
  callSite: SynthesisCallSite;
}> = [
  { surface: "synthesis_draft", callSite: "draft" },
  { surface: "synthesis_brief", callSite: "brief" },
  { surface: "synthesis_pdu", callSite: "pdu" },
];

/**
 * Build the resolved routing table. For each synthesis surface the row shows
 * the hop that will actually SERVE the next call: the live provider decision
 * when one is authorized, otherwise the site's Anthropic leg
 * (cc_subprocess/messages_api + model from resolveCallSiteRouting).
 */
export function buildResolvedRoutingTable(env: RoutingEnv = process.env): RoutingTableRow[] {
  const rows: RoutingTableRow[] = SYNTHESIS_TABLE_SITES.map(({ surface, callSite }) => {
    const routing = resolveCallSiteRouting(callSite);
    const decision = resolveRoute(
      {
        surface,
        taskClass: `startup-table-${callSite}`,
        currentModel: routing.model,
        currentTransport: routing.transport,
        currentAuthEnvVar:
          routing.transport === "cc_subprocess" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY",
      },
      env,
    );
    if (decision.liveInvocationAllowed && decision.provider !== "anthropic") {
      return {
        call_site: surface,
        provider: decision.provider,
        model: decision.model,
        transport: decision.transport,
        live: true,
        reason: decision.reason,
      };
    }
    return {
      call_site: surface,
      provider: "anthropic",
      model: routing.model,
      transport: routing.transport,
      live: false,
      reason: decision.reason,
    };
  });

  const recommendation = resolveRoute(
    { surface: "recommendation", taskClass: "startup-table-recommendation" },
    env,
  );
  rows.push({
    call_site: "recommendation",
    provider: recommendation.provider,
    model: recommendation.model,
    transport: recommendation.transport,
    live: false,
    reason: recommendation.reason,
    note: "non-LLM deterministic classifier — no provider call exists (D-275 N-1)",
  });

  const ccDispatch = resolveRoute(
    {
      surface: "cc_dispatch",
      taskClass: "startup-table-cc-dispatch",
      currentModel: CC_DISPATCH_MODEL,
      currentTransport: "claude_code_oauth",
      currentAuthEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
    },
    env,
  );
  rows.push({
    call_site: "cc_dispatch",
    provider: ccDispatch.provider,
    model: ccDispatch.model,
    transport: ccDispatch.transport,
    live: false,
    reason: ccDispatch.reason,
    note: "protected Claude judgment tier (routing-policy hard wall)",
  });

  return rows;
}

/** Emit the single LLM_ROUTING_TABLE startup line (called from index.ts). */
export function logResolvedRoutingTable(env: RoutingEnv = process.env): void {
  try {
    logger.info("LLM_ROUTING_TABLE", { rows: buildResolvedRoutingTable(env) });
  } catch (error) {
    // The startup table is observability, never a boot blocker.
    logger.warn("LLM_ROUTING_TABLE failed to build", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
