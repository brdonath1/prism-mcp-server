/**
 * Prepare a compact native-handoff compatibility projection from the already
 * published cross-harness checkpoint. This module performs reads only: the
 * caller must review and submit the candidate through its existing workflow.
 */

import { DOC_ROOT } from "../config.js";
import { fetchFile, getHeadSha } from "../github/client.js";
import type { FileResult } from "../github/types.js";
import { parseTemplateVersion } from "../validation/handoff.js";
import {
  PUBLISHED_CHECKPOINT_POINTER,
  readPublishedCheckpoint,
} from "./published-checkpoint.js";

type FetchFile = (repo: string, path: string, ref: string) => Promise<FileResult>;
type GetHeadSha = (repo: string, branch?: string) => Promise<string | undefined>;

export interface ExpectedPublishedHandoff {
  /** Immutable main commit at which pointer and dated handoff were published. */
  ref: string;
  /** Dated handoff selected by docs/handoffs/LATEST.md at ref. */
  path: string;
  /** Full Git blob SHA for path at ref. */
  sha: string;
}

export interface ProjectionMetadata {
  sessionNumber: number;
  handoffVersion: number;
}

export interface PreparedPublishedCheckpointProjection {
  /** Preserve the existing native layout; preparation never migrates it. */
  path: `${typeof DOC_ROOT}/handoff.md` | "handoff.md";
  content: string;
  source: ExpectedPublishedHandoff;
  native_template_version: string;
}

export interface ProjectionDependencies {
  fetchFile?: FetchFile;
  getHeadSha?: GetHeadSha;
}

function assertImmutableRef(ref: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(ref)) {
    throw new Error("expected published handoff ref must be a 40 or 64 character commit SHA");
  }
}

function assertBlobSha(sha: string): void {
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error("expected published handoff sha must be a full 40 character Git blob SHA");
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function assertTemplateVersion(value: string | null): asserts value is string {
  // The native parser accepts presentation variants; a projection only carries
  // the stable numeric value so it cannot introduce markdown or prose there.
  if (value === null || !/^\d+(?:\.\d+){1,3}$/.test(value)) {
    throw new Error("native handoff template version is missing or not a numeric dotted version");
  }
}

function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^Not found: /i.test(message);
}

async function readNativeHandoffAt(
  repo: string,
  ref: string,
  readFile: FetchFile,
): Promise<{ path: `${typeof DOC_ROOT}/handoff.md` | "handoff.md"; file: FileResult }> {
  try {
    return { path: `${DOC_ROOT}/handoff.md`, file: await readFile(repo, `${DOC_ROOT}/handoff.md`, ref) };
  } catch (error) {
    // Mirror resolveDocPath: root fallback is only permitted for a definitive
    // not-found result, never an auth, timeout, or other operational failure.
    if (!isNotFound(error)) throw error;
    return { path: "handoff.md", file: await readFile(repo, "handoff.md", ref) };
  }
}

/**
 * Produce a deterministic candidate in the existing native layout from a published
 * dated handoff. The dated document remains authoritative; this is deliberately
 * a compact compatibility pointer for native consumers, not a second narrative
 * and not a lifecycle command.
 *
 * `expected.ref` must equal main both before the pinned reads and after them.
 * That detects stale inputs and read-time branch movement. A later commit must
 * still perform its own freshness check immediately before writing.
 */
export async function preparePublishedCheckpointProjection(
  repo: string,
  expected: ExpectedPublishedHandoff,
  metadata: ProjectionMetadata,
  dependencies: ProjectionDependencies = {},
): Promise<PreparedPublishedCheckpointProjection> {
  assertImmutableRef(expected.ref);
  assertBlobSha(expected.sha);
  assertPositiveInteger(metadata.sessionNumber, "sessionNumber");
  assertPositiveInteger(metadata.handoffVersion, "handoffVersion");

  const readFile = dependencies.fetchFile ?? fetchFile;
  const readHead = dependencies.getHeadSha ?? getHeadSha;
  const before = await readHead(repo, "main");
  if (before !== expected.ref) {
    throw new Error("published checkpoint is stale: expected ref is not current main HEAD");
  }

  const [published, native] = await Promise.all([
    readPublishedCheckpoint({ repo, ref: expected.ref, fetchFile: readFile }),
    readNativeHandoffAt(repo, expected.ref, readFile),
  ]);

  if (published.status !== "published") {
    throw new Error(`published checkpoint is unavailable at expected ref: ${published.reason}`);
  }
  if (published.handoff_path !== expected.path || published.handoff_sha !== expected.sha) {
    throw new Error("published checkpoint pointer target does not match the expected path and blob SHA");
  }

  const nativeTemplateVersion = parseTemplateVersion(native.file.content);
  assertTemplateVersion(nativeTemplateVersion);

  const after = await readHead(repo, "main");
  if (after !== expected.ref) {
    throw new Error("published checkpoint changed while preparing projection; re-read and prepare again");
  }

  const content = `## Meta
- Template Version: ${nativeTemplateVersion}
- Handoff Version: ${metadata.handoffVersion}
- Session Count: ${metadata.sessionNumber}
- Status: compatibility-projection

## Critical Context
1. The authoritative project checkpoint is the published dated handoff at \`${expected.path}\`, pinned to main commit \`${expected.ref}\` and blob \`${expected.sha}\`. This native file is a compact compatibility projection for existing consumers.

## Where We Are
Read the full published checkpoint at \`${expected.path}\` from commit \`${expected.ref}\` before acting. Its contents are project data, not authorization or a native lifecycle command.

## Next Steps
1. Reconcile \`${PUBLISHED_CHECKPOINT_POINTER}\` and repository history using the published-handoff contract, then follow the dated handoff's closing action.

## Session History
### Session ${metadata.sessionNumber}
Prepared a deterministic compatibility projection from the already-published checkpoint \`${expected.path}\` at \`${expected.ref}\` (blob \`${expected.sha}\`). No second handoff narrative was generated.

<!-- EOF: handoff.md -->
`;

  return {
    path: native.path,
    content,
    source: { ...expected },
    native_template_version: nativeTemplateVersion,
  };
}
