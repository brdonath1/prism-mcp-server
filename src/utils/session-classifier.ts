/**
 * Session classifier (brief-405 / D-191) — recommends a model + thinking
 * setting for the next PRISM session based on a deterministic keyword score
 * over the upcoming work bundle.
 *
 * Surfaced in two places:
 *  - prism_finalize banner (primary, pre-boot signal)
 *  - prism_bootstrap response (secondary, safety net)
 *
 * The recommendation is advisory — the operator overrides via the model
 * selector at session start. Goal is to avoid the wasted-boot scenario
 * where a session opens on Opus 4.7 + Adaptive on for what turns out to
 * be 30 turns of mechanical work.
 */

export type RecommendedModel = "opus-4-7" | "sonnet-4-6" | "haiku-4-5";
export type RecommendedThinking = "adaptive-on" | "adaptive-off";
export type SessionCategory = "reasoning_heavy" | "executional" | "mixed";

export interface SessionRecommendation {
  category: SessionCategory;
  model: RecommendedModel;
  thinking: RecommendedThinking;
  rationale: string;
  display: string;
  scores: {
    reasoning_heavy: number;
    executional: number;
  };
}

export interface ClassifySessionInput {
  next_steps: string[];
  critical_context?: string[];
  opening_message?: string;
}

/**
 * Reasoning-heavy keyword triggers. Hits indicate design / multi-doc
 * investigation / judgment work that benefits from Opus + adaptive thinking.
 *
 * Multi-word phrases must be matched as substrings BEFORE the per-word
 * tokenization runs so they don't get clipped by punctuation/whitespace
 * boundaries. They are stored separately and applied via `includes` against
 * the lowercased text bundle.
 */
const REASONING_KEYWORDS = [
  "design",
  "architect",
  "architecture",
  "brainstorm",
  "investigate",
  "debug",
  "evaluate",
  "analyze",
  "propose",
  "compare",
  "tradeoff",
  "strategy",
] as const;

const REASONING_PHRASES = [
  "decide whether",
  "follow-up on",
] as const;

/**
 * Executional keyword triggers. Hits indicate mechanical cleanup / patches /
 * deterministic application work that's well within Sonnet's range and does
 * not need adaptive thinking overhead.
 */
const EXECUTIONAL_KEYWORDS = [
  "cleanup",
  "rename",
  "patch",
  "push",
  "log",
  "backfill",
  "apply",
  "verify",
  "demote",
  "consolidate",
  "update",
  "bump",
  "sync",
  "enroll",
] as const;

const EXECUTIONAL_PHRASES = [
  "re-tier",
] as const;

/**
 * Conditional keywords — only count when paired with a qualifier in the
 * same item. Prevents false positives on common words ("audit" in
 * "audit log file" is not the same as "audit report" or "audit findings").
 */
interface ConditionalKeyword {
  keyword: string;
  requiresAny: string[];
  bucket: "reasoning" | "executional";
}

const CONDITIONAL_KEYWORDS: ConditionalKeyword[] = [
  { keyword: "audit", requiresAny: ["report", "findings"], bucket: "reasoning" },
  { keyword: "archive", requiresAny: ["content", "session", "insights", "log"], bucket: "executional" },
  { keyword: "restart", requiresAny: ["daemon", "trigger", "service"], bucket: "executional" },
];

/**
 * Count keyword/phrase hits within a single text item.
 * Each occurrence of every distinct keyword counts. Case-insensitive.
 *
 * Phrases are matched as substrings; single keywords are matched as
 * whole-word occurrences (word-boundary regex) so "logging" doesn't
 * accidentally fire on the "log" trigger.
 */
function countHits(
  text: string,
  keywords: ReadonlyArray<string>,
  phrases: ReadonlyArray<string>,
): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let hits = 0;

  for (const phrase of phrases) {
    let idx = 0;
    while ((idx = lower.indexOf(phrase, idx)) !== -1) {
      hits++;
      idx += phrase.length;
    }
  }

  for (const kw of keywords) {
    const re = new RegExp(`\\b${escapeForRegex(kw)}\\b`, "g");
    const matches = lower.match(re);
    if (matches) hits += matches.length;
  }

  return hits;
}

function countConditionalHits(text: string, bucket: "reasoning" | "executional"): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let hits = 0;

  for (const cond of CONDITIONAL_KEYWORDS) {
    if (cond.bucket !== bucket) continue;
    const kwRe = new RegExp(`\\b${escapeForRegex(cond.keyword)}\\b`, "g");
    const matches = lower.match(kwRe);
    if (!matches) continue;
    const hasQualifier = cond.requiresAny.some((q) => lower.includes(q.toLowerCase()));
    if (hasQualifier) hits += matches.length;
  }

  return hits;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Score a single text item against both buckets.
 */
function scoreItem(text: string): { reasoning: number; executional: number } {
  const reasoning =
    countHits(text, REASONING_KEYWORDS, REASONING_PHRASES) +
    countConditionalHits(text, "reasoning");
  const executional =
    countHits(text, EXECUTIONAL_KEYWORDS, EXECUTIONAL_PHRASES) +
    countConditionalHits(text, "executional");
  return { reasoning, executional };
}

/**
 * Format the rationale string for the recommendation.
 * Capped at 80 chars to fit in the banner code fence.
 */
function buildRationale(category: SessionCategory): string {
  const RATIONALES: Record<SessionCategory, string> = {
    reasoning_heavy: "Queue includes design / multi-doc investigation",
    executional: "Queue is mechanical cleanup / patches",
    mixed: "Mixed queue — execution with some judgment",
  };
  const text = RATIONALES[category];
  return text.length > 80 ? text.slice(0, 77) + "..." : text;
}

const DISPLAY_BY_CATEGORY: Record<SessionCategory, string> = {
  reasoning_heavy: "Opus 4.7 · Adaptive on",
  executional: "Sonnet 4.6 · Adaptive off",
  mixed: "Opus 4.7 · Adaptive off",
};

const MODEL_BY_CATEGORY: Record<SessionCategory, RecommendedModel> = {
  reasoning_heavy: "opus-4-7",
  executional: "sonnet-4-6",
  mixed: "opus-4-7",
};

const THINKING_BY_CATEGORY: Record<SessionCategory, RecommendedThinking> = {
  reasoning_heavy: "adaptive-on",
  executional: "adaptive-off",
  mixed: "adaptive-off",
};

/**
 * Classify the next session and produce a recommended model + thinking
 * setting. Pure function — no I/O.
 *
 * Decision rule:
 *   ratio = reasoning_heavy_score / max(executional_score, 1)
 *   ratio >= 1.5  → reasoning_heavy → Opus 4.7 + Adaptive on
 *   ratio <= 0.67 → executional     → Sonnet 4.6 + Adaptive off
 *   otherwise     → mixed           → Opus 4.7 + Adaptive off (strong default)
 *
 * Empty input yields the mixed verdict — safe default that matches the
 * pre-classifier behavior of running Opus + Adaptive off.
 */
export function classifySession(input: ClassifySessionInput): SessionRecommendation {
  let reasoningScore = 0;
  let executionalScore = 0;

  for (const step of input.next_steps ?? []) {
    const s = scoreItem(step);
    reasoningScore += s.reasoning;
    executionalScore += s.executional;
  }

  for (const ctx of input.critical_context ?? []) {
    const s = scoreItem(ctx);
    reasoningScore += s.reasoning;
    executionalScore += s.executional;
  }

  // opening_message reflects current intent and gets 2x weight when present.
  if (input.opening_message) {
    const s = scoreItem(input.opening_message);
    reasoningScore += s.reasoning * 2;
    executionalScore += s.executional * 2;
  }

  const ratio = reasoningScore / Math.max(executionalScore, 1);

  let category: SessionCategory;
  if (reasoningScore === 0 && executionalScore === 0) {
    category = "mixed";
  } else if (ratio >= 1.5) {
    category = "reasoning_heavy";
  } else if (ratio <= 0.67) {
    category = "executional";
  } else {
    category = "mixed";
  }

  return {
    category,
    model: MODEL_BY_CATEGORY[category],
    thinking: THINKING_BY_CATEGORY[category],
    rationale: buildRationale(category),
    display: DISPLAY_BY_CATEGORY[category],
    scores: {
      reasoning_heavy: reasoningScore,
      executional: executionalScore,
    },
  };
}
