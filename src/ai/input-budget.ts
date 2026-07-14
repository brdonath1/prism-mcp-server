/**
 * Synthesis input budgeting — durable CS-1 timeout backstop (brief-445 /
 * R3-dur / D-240 Phase B, audit brief-431 row R3).
 *
 * Bounds the COMBINED synthesis input (the assembled user message built from
 * a project's living documents) to SYNTHESIS_INPUT_MAX_TOKENS. R3-imm
 * (brief-438) removed the dominant input (insights.md 407KB → ~18KB); this
 * module is the durable half — no future doc growth (a large architecture.md,
 * a long task-queue, decisions accretion) can re-trigger the 180s
 * SYNTHESIS_TIMEOUT, because an over-ceiling input is deterministically
 * trimmed before the model call instead of failing.
 *
 * Design invariants:
 *  - NO-OP at or under the ceiling: inputs <= SYNTHESIS_INPUT_MAX_TOKENS pass
 *    through byte-for-byte unchanged (the normal case post-438).
 *  - Deterministic: same input docs → same trimmed prompt. No timestamps, no
 *    randomness — a nondeterministic trim would make the intelligence brief
 *    flap between finalizes.
 *  - Signal-preserving: trims the largest / lowest-signal inputs first and
 *    keeps the most-recent portion of chronological docs (see TRIM ORDER and
 *    RETENTION DIRECTION below).
 *  - Hard bound: the returned doc set always assembles to
 *    <= SYNTHESIS_INPUT_MAX_TOKENS, no matter how pathological the input
 *    shape (defensive stub pass).
 */

import {
  SYNTHESIS_CHARS_PER_TOKEN,
  SYNTHESIS_INPUT_MAX_TOKENS,
  SYNTHESIS_INPUT_TARGET_TOKENS,
} from "../config.js";
import { detectSessionLogOrientation } from "../utils/archive.js";

/** Doc entry shape shared with resolveDocFiles / the prompt builders.
 *  brief-s202b T9: `size` is the TRUE ORIGINAL source size and is preserved
 *  through trimming — the prompt builders print it in each `### FILE:` header,
 *  so the synthesis model must never see a post-trim size it could cite as a
 *  file fact (the INS-363-adjacent hazard that blocked the operator's
 *  `synthesis_brief` → GLM re-flip). */
export interface SynthesisDocEntry {
  content: string;
  size: number;
}

/** Per-doc trim report — which inputs were trimmed and by how much. */
export interface TrimmedDocReport {
  path: string;
  pre_tokens: number;
  post_tokens: number;
}

/** Observability summary attached to logs and SynthesisOutcome (brief-445 §4). */
export interface SynthesisInputBudgetReport {
  /** Estimated tokens of the assembled message BEFORE any trimming. */
  pre_trim_tokens: number;
  /** Estimated tokens of the assembled message actually fed to the model. */
  post_trim_tokens: number;
  /** Whether the bound fired. False on the normal-case NO-OP path. */
  trimmed: boolean;
  /** Per-doc trim detail, in the order docs were trimmed. Empty when !trimmed. */
  trimmed_docs: TrimmedDocReport[];
}

export interface BoundSynthesisInputResult extends SynthesisInputBudgetReport {
  /** Doc set to feed the prompt builder. Same Map instance as the input when
   *  no trimming fired; a fresh Map with trimmed copies otherwise. */
  docs: Map<string, SynthesisDocEntry>;
}

/**
 * Estimate tokens for synthesis input text. chars / 3.5, matching the
 * boot-cost estimator in src/tools/bootstrap.ts (ME-5 / brief-433) so the
 * server speaks one token dialect. See SYNTHESIS_CHARS_PER_TOKEN for why a
 * real tokenizer is not used here.
 */
export function estimateSynthesisTokens(text: string): number {
  return Math.round(text.length / SYNTHESIS_CHARS_PER_TOKEN);
}

/**
 * TRIM ORDER — keep-priority ranks; LOWER rank = higher signal = trimmed
 * LAST. Trimming walks docs from the highest rank down ("priority-trim the
 * largest / lowest-signal inputs first" — brief-445 §2), so the highest-signal
 * content (recent decisions, active insights, handoff) survives:
 *
 *   0. handoff.md            — lean state pointer; the single highest-signal doc
 *   1. decisions/_INDEX.md   — decision registry (recent decisions; never compressed)
 *   2. insights.md           — active insights + standing rules (D-41)
 *   3. task-queue.md         — active work items
 *   4. known-issues.md       — live bugs / workarounds
 *   5. session-log.md        — recent narrative is high-signal, but the file is
 *                              historically the dominant bloat source; its
 *                              recent head survives via HEAD retention below
 *   6. architecture.md       — reference; changes slowly
 *   7. glossary.md           — reference; lowest churn
 *   8. eliminated.md         — historical rejections; lowest live signal
 *   9. decisions/<domain>.md — back-compat domain splits (D-67)
 *  10. anything else         — unknown future doc sources
 *
 * Within the same rank (domain files, unknown docs) the LARGEST doc is
 * trimmed first; ties break lexicographically by path. Fully deterministic.
 */
const KEEP_PRIORITY: Record<string, number> = {
  "handoff.md": 0,
  "decisions/_INDEX.md": 1,
  "insights.md": 2,
  "task-queue.md": 3,
  "known-issues.md": 4,
  "session-log.md": 5,
  "architecture.md": 6,
  "glossary.md": 7,
  "eliminated.md": 8,
};
const DOMAIN_FILE_RANK = 9;
const UNKNOWN_DOC_RANK = 10;

function keepRank(path: string): number {
  const explicit = KEEP_PRIORITY[path];
  if (explicit !== undefined) return explicit;
  if (path.startsWith("decisions/")) return DOMAIN_FILE_RANK;
  return UNKNOWN_DOC_RANK;
}

/**
 * RETENTION DIRECTION — which end of a doc holds the recent / high-signal
 * content ("prefer recent sections" — brief-445 §2). Grounded in the writers:
 *
 *  - TAIL retention (newest entries at the BOTTOM → drop the head):
 *    insights.md (INSIGHTS_ARCHIVE_CONFIG mostRecentAt: "bottom"),
 *    eliminated.md (entries appended), decisions/_INDEX.md + domain files
 *    (prism_log_decision inserts rows before the EOF sentinel).
 *  - session-log.md: orientation is PER-PROJECT (brief-459 / SRV-04 — the
 *    INS-316 inversion class). prism's real log is chronological (newest
 *    LAST → tail retention); other projects write newest-first (→ head
 *    retention). Detected from the `### Session N` endpoint numbers via the
 *    same helper finalize's archiver uses (archive.ts "auto" heuristic) so
 *    the two consumers can never diverge again. The old hardcoded HEAD
 *    retention cited SESSION_LOG_ARCHIVE_CONFIG `mostRecentAt: "top"` — a
 *    value brief-453 deleted — and silently dropped the NEWEST sessions
 *    from synthesis input on chronological logs.
 *  - HEAD retention (everything else → drop the tail): the reference docs
 *    (handoff, architecture, glossary, task-queue, known-issues) lead with
 *    their summary/meta sections. Also the default for unknown docs.
 */
function retainsTail(path: string, content: string): boolean {
  if (path === "session-log.md") {
    return detectSessionLogOrientation(content) === "bottom";
  }
  return (
    path === "insights.md" ||
    path === "eliminated.md" ||
    path.startsWith("decisions/")
  );
}

/** Floor (estimated tokens) on each doc's trim BUDGET in the first pass, so
 *  the synthesis prompt's "read ALL of these" contract degrades gracefully —
 *  every doc stays represented. The actually-kept content can land somewhat
 *  below the floor after the embedded truncation notice and line-boundary
 *  rounding (both paid inside the budget). 1K tokens × the full 16-doc set
 *  ≈ 16K tokens, comfortably under the 60K trim goal, which is what makes a
 *  single trim pass mathematically sufficient (see boundSynthesisInput).
 *  Exported so tests can band-assert that trimmed docs retain a meaningful
 *  fraction of the floor (metaswarm review, brief-445). */
export const TRIM_DOC_FLOOR_TOKENS = 1_000;

/** Small extra amount (estimated tokens) taken beyond the exact excess when
 *  trimming a doc. Token estimates round (Math.round) and cuts land on line
 *  boundaries, so an exact-excess take can leave the total a token or two
 *  over goal — which would cascade a pointless trim onto the NEXT
 *  (higher-signal) doc. The pad swallows the rounding slop. Deterministic. */
const TRIM_TAKE_PAD_TOKENS = 16;

/** Deterministic truncation notice embedded at the cut point so both the
 *  synthesis model and any human reading the prompt can see the doc was
 *  bounded. Derives only from path + sizes — never timestamps.
 *
 *  brief-s202b T9 (INS-363-adjacent): the annotation leads with the TRUE
 *  pre-trim size and an explicit do-not-cite instruction. Pre-s202b the
 *  notice named only estimated tokens, and a trimmed doc's shrunken content
 *  could be described by the synthesized brief as if it were the file's real
 *  size — a fabricated quantitative claim (INS-40 class). */
function trimNotice(path: string, preBytes: number, preTokens: number, detail: string): string {
  return `> [trimmed from ${(preBytes / 1024).toFixed(1)} KB — do not cite truncated size as a file fact] ${path}: ${detail}; ~${preTokens} estimated tokens pre-trim (synthesis input budget, brief-445/R3-dur).`;
}

const encoder = new TextEncoder();
function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Lowest-signal-first trim order (see TRIM ORDER above). Computed from the
 *  ORIGINAL doc sizes so the walk order cannot depend on trim side effects. */
function trimOrder(docs: Map<string, SynthesisDocEntry>): string[] {
  return [...docs.keys()].sort((a, b) => {
    const rankDelta = keepRank(b) - keepRank(a); // higher rank (lower signal) first
    if (rankDelta !== 0) return rankDelta;
    const aSize = docs.get(a)?.content.length ?? 0;
    const bSize = docs.get(b)?.content.length ?? 0;
    if (bSize !== aSize) return bSize - aSize; // largest first within a rank
    return a < b ? -1 : a > b ? 1 : 0; // lexicographic tiebreak
  });
}

/**
 * Reduce one doc's content to ~keepTokens, keeping the recent / high-signal
 * end (see RETENTION DIRECTION). The truncation notice is paid for INSIDE the
 * budget, and cuts prefer line boundaries (rounding the kept content DOWN),
 * so the result never exceeds the requested budget. When the nearest line
 * boundary would forfeit more than half the budget (single-line blobs — e.g.
 * a minified JSON dump pasted into a session log), a hard character cut is
 * used instead so the per-doc floor stays meaningful. Both paths are
 * deterministic.
 */
function retainWithinBudget(
  path: string,
  content: string,
  keepTokens: number,
  trueSourceBytes?: number,
): string {
  const keepChars = Math.max(0, Math.floor(keepTokens * SYNTHESIS_CHARS_PER_TOKEN));
  const preTokens = estimateSynthesisTokens(content);
  // brief-s202b T9: cite the TRUE source size (the same number the FILE
  // header prints), falling back to the current content's byte length.
  const preBytes = trueSourceBytes ?? byteLength(content);

  if (retainsTail(path, content)) {
    // Newest content at the bottom — drop the oldest (leading) content. Keep
    // the doc's title line when present so the retained tail stays anchored
    // to an identifiable document.
    const firstLineEnd = content.indexOf("\n");
    const titleLine =
      content.startsWith("# ") && firstLineEnd !== -1
        ? content.slice(0, firstLineEnd + 1)
        : "";
    const notice = trimNotice(
      path,
      preBytes,
      preTokens,
      "oldest (leading) content dropped, most recent entries retained",
    );
    const tailBudget = keepChars - titleLine.length - notice.length - 1;
    if (tailBudget <= 0) return `${titleLine}${notice}\n`;
    const tailStart = content.length - tailBudget;
    const cutAt = content.indexOf("\n", tailStart);
    let tail = cutAt === -1 ? "" : content.slice(cutAt + 1);
    if (tail.length < tailBudget / 2) tail = content.slice(tailStart);
    return `${titleLine}${notice}\n${tail}`;
  }

  // Newest-first session-logs (per detected orientation) and reference docs —
  // keep the leading content, drop the tail ("drop … the tail of oversized
  // docs").
  const notice = trimNotice(
    path,
    preBytes,
    preTokens,
    "trailing content dropped, leading (most recent / summary) content retained",
  );
  const headBudget = keepChars - notice.length - 1;
  if (headBudget <= 0) return `${notice}\n`;
  const cutAt = content.lastIndexOf("\n", headBudget);
  let head = cutAt <= 0 ? content.slice(0, headBudget) : content.slice(0, cutAt);
  if (head.length < headBudget / 2) head = content.slice(0, headBudget);
  return `${head}\n${notice}\n`;
}

/**
 * Bound the combined synthesis input to SYNTHESIS_INPUT_MAX_TOKENS.
 *
 * Measures the REAL assembled message via the caller-supplied builder (the
 * same builder the caller will use for the actual model call), so the bound
 * is enforced on exactly the prompt the model receives — headers, preamble
 * and all — with zero drift risk between measurement and assembly.
 *
 * Algorithm (all steps deterministic):
 *  1. If the assembled message is <= SYNTHESIS_INPUT_MAX_TOKENS → NO-OP:
 *     return the input map untouched. This includes the target..ceiling gray
 *     zone — inputs under the ceiling are never trimmed.
 *  2. Otherwise walk docs lowest-signal-first (TRIM ORDER), reducing each
 *     doc's contribution — down to at most TRIM_DOC_FLOOR_TOKENS — until the
 *     assembled message fits SYNTHESIS_INPUT_TARGET_TOKENS (the trim goal;
 *     see the config constant for the trim-to-target-not-ceiling rationale).
 *     One pass suffices: Σ floors (~16K) + preamble overhead is far below
 *     the 60K goal, so the walk always reaches goal before exhausting docs.
 *  3. Defensive stub pass: if the message is somehow still over the CEILING
 *     (only reachable with absurd doc counts or a misconfigured env target),
 *     stub docs out entirely, lowest-signal first, until it fits. Keeps the
 *     <= MAX guarantee unconditional.
 */
export function boundSynthesisInput(
  docs: Map<string, SynthesisDocEntry>,
  buildMessage: (docs: Map<string, SynthesisDocEntry>) => string,
): BoundSynthesisInputResult {
  const preTrimTokens = estimateSynthesisTokens(buildMessage(docs));
  if (preTrimTokens <= SYNTHESIS_INPUT_MAX_TOKENS) {
    return {
      docs,
      pre_trim_tokens: preTrimTokens,
      post_trim_tokens: preTrimTokens,
      trimmed: false,
      trimmed_docs: [],
    };
  }

  // Misconfiguration guard: if the env-overridden target exceeds the ceiling,
  // trim to the ceiling.
  const goal = Math.min(SYNTHESIS_INPUT_TARGET_TOKENS, SYNTHESIS_INPUT_MAX_TOKENS);

  // Work on copies — never mutate the caller's doc map or entries.
  const working = new Map<string, SynthesisDocEntry>(
    [...docs].map(([path, entry]) => [path, { ...entry }]),
  );
  const order = trimOrder(docs);
  const trimmedDocs: TrimmedDocReport[] = [];

  // Pass 1 — priority trim, lowest-signal docs first, re-measuring through
  // the real builder each step so header/notice overhead self-corrects.
  for (const path of order) {
    const total = estimateSynthesisTokens(buildMessage(working));
    if (total <= goal) break;
    const entry = working.get(path);
    if (!entry) continue;
    const entryTokens = estimateSynthesisTokens(entry.content);
    const reducible = entryTokens - TRIM_DOC_FLOOR_TOKENS;
    if (reducible <= 0) continue; // already at/under the per-doc floor
    const take = Math.min(total - goal + TRIM_TAKE_PAD_TOKENS, reducible);
    const newContent = retainWithinBudget(path, entry.content, entryTokens - take, entry.size);
    // brief-s202b T9: `size` stays the TRUE original source size (metadata),
    // never the trimmed byte count — the prompt's `### FILE:` header cites
    // it, and the model must not see a post-trim size as a file fact.
    working.set(path, { content: newContent, size: entry.size });
    trimmedDocs.push({
      path,
      pre_tokens: entryTokens,
      post_tokens: estimateSynthesisTokens(newContent),
    });
  }

  // Pass 2 — defensive hard clamp against the CEILING (not the goal). Stubs
  // whole docs, lowest-signal first. Unreachable for any realistic doc set
  // (see pass-1 math); kept so the <= MAX bound is unconditional.
  let postTrimTokens = estimateSynthesisTokens(buildMessage(working));
  if (postTrimTokens > SYNTHESIS_INPUT_MAX_TOKENS) {
    for (const path of order) {
      if (postTrimTokens <= SYNTHESIS_INPUT_MAX_TOKENS) break;
      const entry = working.get(path);
      if (!entry) continue;
      const entryTokens = estimateSynthesisTokens(entry.content);
      const stub = `${trimNotice(path, entry.size, entryTokens, "entire document elided to honor the synthesis input ceiling")}\n`;
      if (stub.length >= entry.content.length) continue; // stub wouldn't shrink it
      // brief-s202b T9: original size preserved (see pass-1 note).
      working.set(path, { content: stub, size: entry.size });
      const existing = trimmedDocs.find((t) => t.path === path);
      const stubTokens = estimateSynthesisTokens(stub);
      if (existing) {
        existing.post_tokens = stubTokens;
      } else {
        trimmedDocs.push({ path, pre_tokens: entryTokens, post_tokens: stubTokens });
      }
      postTrimTokens = estimateSynthesisTokens(buildMessage(working));
    }
  }

  return {
    docs: working,
    pre_trim_tokens: preTrimTokens,
    post_trim_tokens: postTrimTokens,
    trimmed: true,
    trimmed_docs: trimmedDocs,
  };
}
