/**
 * rules_hint — stateless module nudges (brief-s202b T2, proposals §3b).
 *
 * The S202 kernel split (s202c) moves module HOW-text out of the always-boot
 * template behind trigger conditions. The stateless server sees every tool
 * call, so matching calls carry a ≤120-byte additive hint field delivered
 * exactly at the moment of relevance — the prevention-side complement to the
 * audit harness's detection-side Probe H. Emitted on EVERY matching call
 * (the server cannot know what the session already loaded); harmless when
 * the module is already in context.
 */

import { DOC_ROOT } from "../config.js";

/** Hard budget for any rules_hint string (bytes). */
export const RULES_HINT_MAX_BYTES = 120;

/** Prefix identifying document-ingest writes. */
export const INGEST_PATH_PREFIX = `${DOC_ROOT}/ingest/`;

/** Hint attached to prism_push / prism_patch calls targeting `.prism/ingest/`. */
export const INGEST_RULES_HINT =
  "Ingest write detected — load modules/document-ingest.md (D-270) first if not already in context.";

/** Hint attached to every cc_dispatch response. */
export const CC_DISPATCH_RULES_HINT =
  "CC-channel discipline lives in reference/trigger-channel.md — load it before further dispatch work.";

/**
 * Return the ingest-module hint when any target path is under
 * `.prism/ingest/`, else undefined (the field is additive — absent when not
 * relevant, never null).
 */
export function ingestRulesHint(paths: string[]): string | undefined {
  return paths.some(p => p.startsWith(INGEST_PATH_PREFIX)) ? INGEST_RULES_HINT : undefined;
}
