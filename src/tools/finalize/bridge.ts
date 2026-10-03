/**
 * prism_finalize — draft-to-living-document bridge.
 *
 * Extracted verbatim from `src/tools/finalize.ts` (D-FINALIZE-SPLIT F1): the
 * pure seam that translates the FINALIZATION_DRAFT_PROMPT's contract-shaped
 * keys into real session-log / task-queue mutations. Shared by draft.ts
 * (composeDraftFiles) and fullPhase, so it must not import finalize.ts.
 */

import { detectSessionLogOrientation } from "../../utils/archive.js";

/**
 * brief-456 (SRV-19): result of bridging the FINALIZATION_DRAFT_PROMPT's
 * contract-shaped keys into real living-document mutations.
 */
export interface DraftBridgeResult {
  /** Translated doc mutations, ready for the commit files[] set. */
  files: Array<{ path: string; content: string }>;
  /** Contract keys that produced at least one mutation. */
  bridged: string[];
  /** Contract keys (or parts of them) that could not be bridged, with reasons. */
  skipped: Array<{ key: string; reason: string }>;
}

const HANDOFF_DRAFT_KEYS = [
  "handoff_where_we_are",
  "handoff_next_steps",
  "handoff_session_history",
] as const;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Insert a drafted `### Session N` entry into session-log.md, orientation-
 * aware (brief-456 / SRV-19): newest-first logs get the entry above the
 * first existing entry; newest-last logs get it above the EOF sentinel.
 * Orientation comes from archive.ts's shared heuristic — guessing wrong is
 * the INS-316 bug class.
 */
function insertSessionLogEntry(sessionLog: string, entry: string): string {
  const block = `${entry.trimEnd()}\n`;
  if (detectSessionLogOrientation(sessionLog) === "top") {
    const firstEntry = sessionLog.search(/^### Session \d+/m);
    if (firstEntry !== -1) {
      return `${sessionLog.slice(0, firstEntry)}${block}\n${sessionLog.slice(firstEntry)}`;
    }
  }
  const eofMatch = sessionLog.match(/^<!--\s*EOF:.*-->\s*$/m);
  if (eofMatch && eofMatch.index !== undefined) {
    const head = sessionLog.slice(0, eofMatch.index).replace(/\s+$/, "");
    const tail = sessionLog.slice(eofMatch.index);
    return `${head}\n\n${block}\n${tail}`;
  }
  return `${sessionLog.trimEnd()}\n\n${block}`;
}

/** Flip the first open `- [ ]` line containing the task text to `- [x]`. */
function markTaskCompleted(taskQueue: string, taskText: string): string | null {
  const lines = taskQueue.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(taskText) && /^\s*-\s*\[ \]/.test(lines[i])) {
      lines[i] = lines[i].replace("- [ ]", "- [x]");
      return lines.join("\n");
    }
  }
  return null;
}

/**
 * Append a `[Section] task text` item as `- [ ] task text` at the end of its
 * `## Section` body. Returns null when the prefix is missing or the section
 * does not exist — the caller surfaces it as skipped.
 */
function appendTaskToSection(taskQueue: string, prefixedTask: string): string | null {
  const m = prefixedTask.match(/^\[([^\]]+)\]\s*(.+)$/);
  if (!m) return null;
  const sectionRe = new RegExp(`^##\\s+${escapeRegExp(m[1].trim())}\\s*$`, "m");
  const sectionMatch = taskQueue.match(sectionRe);
  if (!sectionMatch || sectionMatch.index === undefined) return null;
  const bodyStart = sectionMatch.index + sectionMatch[0].length;
  const tail = taskQueue.slice(bodyStart);
  const boundary = tail.search(/^##\s+\S|^<!--\s*EOF:/m);
  const insertAt = boundary === -1 ? taskQueue.length : bodyStart + boundary;
  const head = taskQueue.slice(0, insertAt).replace(/\s+$/, "");
  const rest = taskQueue.slice(insertAt);
  return `${head}\n- [ ] ${m[2].trim()}\n\n${rest}`;
}

/**
 * Translate the draft contract's section-shaped keys into real doc
 * mutations (brief-456 / SRV-19). Pure — exported for direct unit testing.
 *
 * - `session_log_entry` → orientation-aware insertion into session-log.md.
 * - `task_queue_completed` → `- [ ]` → `- [x]` on matching open task lines.
 * - `task_queue_new` → `[Up Next]`/`[Parking Lot]`-prefixed items appended
 *   to their target section.
 * - `handoff_*` keys are deliberately NOT translated: the full action
 *   requires operator-supplied handoff_content, which takes precedence
 *   (same rule as the existing draft `handoff.md` key skip).
 *
 * Anything unbridgeable lands in `skipped` with a reason — visible, never
 * silent (the caller turns these into DRAFT_KEY_SKIPPED diagnostics).
 */
export function bridgeDraftSections(
  drafts: Record<string, unknown>,
  current: { sessionLog?: string; taskQueue?: string },
): DraftBridgeResult {
  const result: DraftBridgeResult = { files: [], bridged: [], skipped: [] };

  for (const key of HANDOFF_DRAFT_KEYS) {
    if (key in drafts) {
      result.skipped.push({
        key,
        reason: "operator-supplied handoff.md takes precedence (handoff_content)",
      });
    }
  }

  const entry = drafts.session_log_entry;
  if (typeof entry === "string" && entry.trim().length > 0) {
    if (typeof current.sessionLog !== "string") {
      result.skipped.push({
        key: "session_log_entry",
        reason: "session-log.md could not be fetched — entry not bridged",
      });
    } else {
      result.files.push({
        path: "session-log.md",
        content: insertSessionLogEntry(current.sessionLog, entry),
      });
      result.bridged.push("session_log_entry");
    }
  }

  const completed = Array.isArray(drafts.task_queue_completed)
    ? drafts.task_queue_completed.filter((t): t is string => typeof t === "string")
    : [];
  const newTasks = Array.isArray(drafts.task_queue_new)
    ? drafts.task_queue_new.filter((t): t is string => typeof t === "string")
    : [];

  if (completed.length > 0 || newTasks.length > 0) {
    if (typeof current.taskQueue !== "string") {
      if (completed.length > 0) {
        result.skipped.push({
          key: "task_queue_completed",
          reason: "task-queue.md could not be fetched — completions not bridged",
        });
      }
      if (newTasks.length > 0) {
        result.skipped.push({
          key: "task_queue_new",
          reason: "task-queue.md could not be fetched — new tasks not bridged",
        });
      }
    } else {
      let taskQueueContent = current.taskQueue;
      let mutated = false;

      const unmatched: string[] = [];
      for (const task of completed) {
        const flipped = markTaskCompleted(taskQueueContent, task);
        if (flipped === null) {
          unmatched.push(task);
        } else {
          taskQueueContent = flipped;
          mutated = true;
        }
      }
      if (unmatched.length > 0) {
        result.skipped.push({
          key: "task_queue_completed",
          reason: `no matching open task line for: ${unmatched.join("; ")}`,
        });
      }
      if (completed.length > unmatched.length) {
        result.bridged.push("task_queue_completed");
      }

      const unplaced: string[] = [];
      for (const task of newTasks) {
        const placed = appendTaskToSection(taskQueueContent, task);
        if (placed === null) {
          unplaced.push(task);
        } else {
          taskQueueContent = placed;
          mutated = true;
        }
      }
      if (unplaced.length > 0) {
        result.skipped.push({
          key: "task_queue_new",
          reason: `no matching task-queue section (or missing [Section] prefix) for: ${unplaced.join("; ")}`,
        });
      }
      if (newTasks.length > unplaced.length) {
        result.bridged.push("task_queue_new");
      }

      if (mutated) {
        result.files.push({ path: "task-queue.md", content: taskQueueContent });
      }
    }
  }

  return result;
}
