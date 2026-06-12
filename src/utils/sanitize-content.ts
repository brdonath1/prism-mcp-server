/**
 * Level- and fence-aware neutralization of embedded markdown section headers
 * in user-supplied content (KI-26 defense, redesigned per brief-460 / M-007).
 *
 * Mechanism: inserts a Unicode zero-width space (U+200B) between the leading
 * `#` run and the following space on header-shaped lines. The line then no
 * longer parses as a section header (parseSections' HEADER_RE requires
 * whitespace after the hashes, and `/\s/.test("\u200B") === false`). Rendered
 * output is NOT a header either — CommonMark requires a space/tab after the
 * hash run, so the line renders as literal text with the hashes visible
 * (SRV-98: the pre-redesign docstring claimed it "remains readable ... in
 * rendered output", which overstated it).
 *
 * What gets neutralized (and what survives) — brief-460 / SRV-03/29/53/77:
 *
 *  - LEVEL-AWARE: only headers at level <= `targetLevel` are neutralized.
 *    parseSections bounds a section at the next SAME-OR-HIGHER-level header,
 *    so only those levels can escape or collide with the target section's
 *    boundary (KI-26's exploit was `## Injected` against a `##` section:
 *    level 2 <= 2 — still neutralized). Deeper headers are legitimate
 *    subsection structure that the replace contract REQUIRES callers to
 *    resend (a `## X` body includes its `### ` subsections) — they survive
 *    byte-identical. Default targetLevel is 6 (neutralize everything) for
 *    call sites with no section context.
 *
 *  - FENCE-AWARE: content inside balanced code fences is never touched —
 *    parseSections ignores fenced lines (FENCE_RE /^```/ toggle), so a
 *    fenced `# comment` was never a header to the parser and neutralizing
 *    it corrupted code samples for zero protective value (SRV-29). When the
 *    fence count is UNBALANCED the walk falls back to fence-blind behavior
 *    (every header-shaped line at level <= targetLevel is neutralized) —
 *    an unterminated fence makes "inside a fence" undecidable, so the safe
 *    side is the protective one.
 *
 *  - ANCHOR MODES (SRV-77): `"line-start"` (default) treats the first line
 *    of the string as a potential header — correct for content written at
 *    line start (prism_patch content). `"newline-only"` skips the first
 *    line — for fields embedded MID-LINE in server-built templates (e.g.
 *    `- Reasoning: ${value}` / `### ${id}: ${title}`), where the field's
 *    first line can never start a header but embedded `\n## ...` lines can.
 *
 * Call sites covered (the complete enumeration — SRV-98):
 *  - src/tools/patch.ts — patch content, targetLevel from the target section
 *  - src/tools/log-decision.ts — title/reasoning/assumptions/impact
 *    (newline-only, targetLevel 3 = the `### D-N:` entry level)
 *  - src/tools/log-insight.ts — title/description/procedure (newline-only,
 *    targetLevel 3 = the `### INS-N:` entry level)
 *  - src/utils/apply-pdu.ts — AI-synthesized proposal bodies (section ops:
 *    targetLevel from the proposal's target section; glossary rows: full)
 *
 * Intentional exceptions (full-document write channels, NOT sanitized):
 * prism_push, prism_finalize files[], synthesize artifact pushes, and
 * cc-worker pushes write WHOLE documents whose headers at every level are
 * the document's own structure — sanitizing would corrupt them. Those
 * channels get ZWS contamination DETECTION instead (detectZwsHeaders below).
 *
 * Every mutation is reported via `SanitizeOutcome.neutralized` so callers
 * emit a visible diagnostic — silent mutation is the defect class brief-460
 * exists to kill (SRV-03/53).
 */

/** Same fence-delimiter test parseSections uses (markdown-sections.ts). */
const FENCE_RE = /^```/;

/** Header-shaped line: 1-6 hashes followed by a literal space. Matches the
 *  pre-redesign neutralization shape exactly (space only, not tab). */
const HEADER_LINE_RE = /^(#{1,6}) /;

/** Neutralization signature: hashes immediately followed by U+200B. */
const ZWS_HEADER_RE = /^(#{1,6})\u200B/;

export interface SanitizeOptions {
  /**
   * Highest header level to neutralize (1..6). Headers DEEPER than this
   * (more hashes) survive untouched. Default 6 — neutralize all levels.
   */
  targetLevel?: number;
  /**
   * "line-start" (default): the first line of the string can be a header.
   * "newline-only": skip the first line — the field is embedded mid-line
   * in a server-built template, so only `\n`-prefixed lines are hazards.
   */
  anchor?: "line-start" | "newline-only";
}

/** One neutralized line, reported for caller-visible diagnostics. */
export interface NeutralizedLine {
  /** 1-based line number within the sanitized field. */
  line: number;
  /** The original header line, pre-neutralization. */
  header: string;
}

export interface SanitizeOutcome {
  /** The sanitized text. Identical to the input when `neutralized` is empty. */
  text: string;
  /** Every line that was neutralized — empty means no mutation occurred. */
  neutralized: NeutralizedLine[];
  /**
   * False when the content carries an odd number of fence delimiters; the
   * walk then falls back to fence-blind neutralization (see module doc).
   */
  fencesBalanced: boolean;
}

/**
 * Neutralize embedded markdown headers per the level/fence/anchor rules
 * above, reporting exactly which lines were mutated.
 */
export function sanitizeContent(
  text: string,
  options: SanitizeOptions = {},
): SanitizeOutcome {
  const targetLevel = options.targetLevel ?? 6;
  const anchor = options.anchor ?? "line-start";

  const lines = text.split("\n");
  const fenceCount = lines.reduce(
    (n, line) => (FENCE_RE.test(line) ? n + 1 : n),
    0,
  );
  const fencesBalanced = fenceCount % 2 === 0;

  const neutralized: NeutralizedLine[] = [];
  let inFence = false;

  const out = lines.map((line, i) => {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (fencesBalanced && inFence) return line;
    if (anchor === "newline-only" && i === 0) return line;

    const m = line.match(HEADER_LINE_RE);
    if (!m || m[1].length > targetLevel) return line;

    neutralized.push({ line: i + 1, header: line });
    return `${m[1]}\u200B ${line.slice(m[0].length)}`;
  });

  return { text: out.join("\n"), neutralized, fencesBalanced };
}

/**
 * String-returning convenience wrapper around {@link sanitizeContent}.
 * Callers that need the mutation report (all production write paths — the
 * report feeds the visible diagnostic) should call sanitizeContent directly.
 */
export function sanitizeContentField(
  text: string,
  options: SanitizeOptions = {},
): string {
  return sanitizeContent(text, options).text;
}

/**
 * Detect ZWS-neutralized headers already present in content — the exact
 * signature this module writes (`#{1,6}` + U+200B at line start).
 *
 * Detection primitive for SRV-78: contamination written by the pre-redesign
 * sanitizer is one-way (no read path strips U+200B), so full-document write
 * channels (push/finalize) surface a ZWS_CONTAMINATION_DETECTED diagnostic
 * instead of silently re-committing the damage. Repairing contaminated
 * documents is M-041 (prism repo) — this function and stripZwsHeaders are
 * the primitives that work consumes.
 */
export function detectZwsHeaders(
  text: string,
): NeutralizedLine[] {
  const found: NeutralizedLine[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (ZWS_HEADER_RE.test(lines[i])) {
      found.push({ line: i + 1, header: lines[i] });
    }
  }
  return found;
}

/**
 * Decontamination primitive (SRV-78 part 7): strip the ZWS neutralization
 * signature, restoring `#{n}\u200B Title` lines to real `#{n} Title`
 * headers. NOT wired into any server write path — restoring headers changes
 * document structure, so the sweep must be operator-driven (M-041).
 */
export function stripZwsHeaders(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(ZWS_HEADER_RE, "$1"))
    .join("\n");
}
