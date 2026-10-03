// D-FINALIZE-SPLIT F0 contract: the public surface of src/tools/finalize.ts.
// The planned extraction into src/tools/finalize/*.ts must keep every symbol
// importable from "../src/tools/finalize.js" (re-exports). Pinned from the
// module as of 4.15.6; adding a symbol is a deliberate edit to this list.
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";

const PINNED_EXPORTS: string[] = [
  "ARCHIVE_FILE_SUFFIX",
  "DRAFT_RELEVANT_DOCS",
  "DRAFT_SUMMARY_MAX_BYTES",
  "TASK_QUEUE_RECENTLY_COMPLETED_CAP",
  "bridgeDraftSections",
  "buildDraftFilesProjection",
  "composeDraftFiles",
  "countLivingDocumentsUpdated",
  "extractJSON",
  "pruneRecentlyCompleted",
  "registerFinalize",
  "resolveDraftDeadline",
  "resolveDraftSummary",
  "resolveDraftTimeout",
  "updateArchitectureMetadata",
];

describe("finalize.ts public surface", () => {
  it("exports exactly the pinned symbol set", async () => {
    const mod = await import("../src/tools/finalize.js");
    expect(Object.keys(mod).sort()).toEqual([...PINNED_EXPORTS].sort());
  });
});
