/**
 * Read the cross-harness published checkpoint without changing PRISM's native
 * handoff schema. The caller snapshots main-branch HEAD first, then this
 * helper reads both the pointer and its target at that immutable commit.
 */

import type { FileResult } from "../github/types.js";
import { fetchFile, getHeadSha } from "../github/client.js";

export const PUBLISHED_CHECKPOINT_POINTER = "docs/handoffs/LATEST.md";
export const PUBLISHED_CHECKPOINT_MAX_BYTES = 24 * 1024;

type FetchFile = (repo: string, path: string, ref: string) => Promise<FileResult>;

export type PublishedCheckpoint =
  | {
      status: "published";
      authority: "docs/handoffs";
      ref: string;
      latest_path: typeof PUBLISHED_CHECKPOINT_POINTER;
      latest_sha: string;
      handoff_path: string;
      handoff_sha: string;
      handoff_content: string;
      files_fetched: 2;
    }
  | {
      status: "native_fallback";
      reason: "pointer_missing" | "pointer_none";
      ref: string;
      files_fetched: 0 | 1;
    }
  | {
      status: "unavailable";
      reason: "head_unavailable" | "invalid_ref" | "pointer_fetch_failed" | "invalid_pointer" | "target_missing" | "target_fetch_failed" | "target_too_large" | "target_empty";
      ref: string;
      detail: string;
      files_fetched: 0 | 1 | 2;
    };

export interface ReadPublishedCheckpointOptions {
  repo: string;
  /** Immutable main-branch commit SHA obtained immediately before the reads. */
  ref: string;
  fetchFile: FetchFile;
  maxBytes?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFound(error: unknown): boolean {
  return /^Not found: /i.test(errorMessage(error));
}

function isImmutableCommitRef(ref: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(ref);
}

/**
 * Extract exactly one nonempty `handoff:` field. Older valid pointers may have
 * fewer metadata fields, so this deliberately validates only the authority
 * selector rather than imposing the current nine-field presentation schema.
 */
export function parsePublishedHandoffPath(pointer: string):
  | { kind: "none" }
  | { kind: "path"; path: string }
  | { kind: "invalid"; detail: string } {
  const matches = pointer.match(/^handoff:[ \t]*(.*?)[ \t]*$/gim) ?? [];
  if (matches.length !== 1) {
    return { kind: "invalid", detail: `expected exactly one handoff field; found ${matches.length}` };
  }
  const value = matches[0].replace(/^handoff:[ \t]*/i, "").trim();
  if (/^none(?: — no dated handoff under this contract yet; the checkpoint is \.prism\/handoff\.md until the first "Finalize session")?$/i.test(value)) return { kind: "none" };
  if (!value) return { kind: "invalid", detail: "handoff field is empty" };
  if (!/^docs\/handoffs\/handoff-[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(value)) {
    return { kind: "invalid", detail: `handoff path is outside the dated handoff contract: ${value}` };
  }
  return { kind: "path", path: value };
}

export async function readPublishedCheckpoint(
  options: ReadPublishedCheckpointOptions,
): Promise<PublishedCheckpoint> {
  const { repo, ref, fetchFile, maxBytes = PUBLISHED_CHECKPOINT_MAX_BYTES } = options;
  if (!isImmutableCommitRef(ref)) {
    return { status: "unavailable", reason: "invalid_ref", ref, detail: "published checkpoint reads require a 40 or 64 character commit SHA", files_fetched: 0 };
  }
  let pointer: FileResult;
  try {
    pointer = await fetchFile(repo, PUBLISHED_CHECKPOINT_POINTER, ref);
  } catch (error) {
    if (isNotFound(error)) return { status: "native_fallback", reason: "pointer_missing", ref, files_fetched: 0 };
    return { status: "unavailable", reason: "pointer_fetch_failed", ref, detail: errorMessage(error), files_fetched: 0 };
  }

  const parsed = parsePublishedHandoffPath(pointer.content);
  if (parsed.kind === "none") return { status: "native_fallback", reason: "pointer_none", ref, files_fetched: 1 };
  if (parsed.kind === "invalid") return { status: "unavailable", reason: "invalid_pointer", ref, detail: parsed.detail, files_fetched: 1 };

  let handoff: FileResult;
  try {
    handoff = await fetchFile(repo, parsed.path, ref);
  } catch (error) {
    return {
      status: "unavailable",
      reason: isNotFound(error) ? "target_missing" : "target_fetch_failed",
      ref,
      detail: errorMessage(error),
      files_fetched: 1,
    };
  }
  if (handoff.size > maxBytes || Buffer.byteLength(handoff.content, "utf8") > maxBytes) {
    return { status: "unavailable", reason: "target_too_large", ref, detail: `dated handoff exceeds ${maxBytes} bytes`, files_fetched: 2 };
  }
  if (!handoff.content.trim()) {
    return { status: "unavailable", reason: "target_empty", ref, detail: "dated handoff is empty", files_fetched: 2 };
  }
  return {
    status: "published",
    authority: "docs/handoffs",
    ref,
    latest_path: PUBLISHED_CHECKPOINT_POINTER,
    latest_sha: pointer.sha,
    handoff_path: parsed.path,
    handoff_sha: handoff.sha,
    handoff_content: handoff.content,
    files_fetched: 2,
  };
}

/**
 * Production convenience wrapper. Keep `getHeadSha` inside the try block:
 * older test/client surfaces that do not provide it degrade to an explicit
 * unavailable state instead of failing bootstrap module registration.
 */
export async function resolvePublishedCheckpoint(repo: string): Promise<PublishedCheckpoint> {
  let ref = "";
  try {
    ref = await getHeadSha(repo, "main") ?? "";
    if (!ref) {
      return { status: "unavailable", reason: "head_unavailable", ref, detail: "main branch HEAD could not be resolved", files_fetched: 0 };
    }
    return await readPublishedCheckpoint({ repo, ref, fetchFile });
  } catch (error) {
    return {
      status: "unavailable",
      reason: ref ? "pointer_fetch_failed" : "head_unavailable",
      ref,
      detail: errorMessage(error),
      files_fetched: 0,
    };
  }
}
