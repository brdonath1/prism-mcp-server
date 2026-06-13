/**
 * SRV-55 (brief-461 Task C) — commitAndPushBranch must scrub the PAT from git
 * error messages, exactly like cloneRepo already does.
 *
 * commitAndPushBranch pushes against an origin whose URL has the PAT baked in
 * (from the clone step). If `git push` fails, git's stderr can echo the
 * credentialed `https://x-access-token:PAT@github.com/...` URL into the thrown
 * error, which then propagates into a committed dispatch record + the chat
 * transcript. The error message must never contain the raw PAT.
 */

process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect, vi, beforeEach } from "vitest";

// Pin GITHUB_PAT to a known value via a config mock. ESM import hoisting means
// config.ts captures process.env.GITHUB_PAT BEFORE any in-file assignment runs,
// so we can't control the scrub target by setting process.env — mock the
// exported binding repo.ts reads instead. (vi.mock is hoisted above imports.)
vi.mock("../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config.js")>();
  return { ...actual, GITHUB_PAT: "ghp_test_pat_SECRET_value", GITHUB_OWNER: "brdonath1" };
});

// Mock node:child_process so no real git runs. The factory is hoisted, so it
// must be self-contained.
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { commitAndPushBranch } from "../src/claude-code/repo.js";

const mockExec = execFileSync as unknown as ReturnType<typeof vi.fn>;
const PAT = "ghp_test_pat_SECRET_value";
const CREDENTIALED_URL = `https://x-access-token:${PAT}@github.com/brdonath1/some-repo.git`;

describe("SRV-55 — commitAndPushBranch scrubs the PAT from git errors", () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it("does not leak the PAT when `git push` throws an error containing the credentialed URL", async () => {
    mockExec.mockImplementation((_file: string, args: string[]) => {
      // Non-empty working tree so the function proceeds to commit + push.
      if (args.includes("status")) return "M changed-file.ts\n";
      if (args.includes("rev-parse")) return "deadbeefcafe\n";
      if (args.includes("push")) {
        throw new Error(
          `Command failed: git push -u origin feat\n` +
            `fatal: unable to access '${CREDENTIALED_URL}': The requested URL returned error: 403`,
        );
      }
      return ""; // config / checkout / add / commit
    });

    let caught: Error | undefined;
    try {
      await commitAndPushBranch("/tmp/workdir", "feat", "prism: cc_dispatch test");
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    // The PAT must NOT appear anywhere in the surfaced error.
    expect(caught!.message).not.toContain(PAT);
    // It should be redacted, and the rest of the diagnostic preserved.
    expect(caught!.message).toContain("***");
    expect(caught!.message).toMatch(/unable to access/);
    expect(caught!.message).toContain("github.com/brdonath1/some-repo.git");
  });

  it("returns cleanly (no push) when there are no changes", async () => {
    mockExec.mockImplementation((_file: string, args: string[]) => {
      if (args.includes("status")) return ""; // clean tree
      return "";
    });

    const result = await commitAndPushBranch("/tmp/workdir", "feat", "prism: test");
    expect(result.filesChanged).toBe(0);
    expect(result.sha).toBe("");
    // push must never have been attempted on a clean tree.
    const pushed = mockExec.mock.calls.some((c) => (c[1] as string[]).includes("push"));
    expect(pushed).toBe(false);
  });
});
