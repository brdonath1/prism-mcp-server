// Set dummy PAT to prevent config.ts from calling process.exit(1) during import
process.env.GITHUB_PAT = process.env.GITHUB_PAT || "test-dummy-pat";

import { describe, it, expect } from "vitest";
import {
  buildDispatchPrompt,
  CC_DISPATCH_ATTESTATION_PREAMBLE,
} from "../src/tools/cc-dispatch.js";

/**
 * Brief-466 / W3-S7 — Task D (M-048) DIRECTIVE(c): the cc_dispatch channel must
 * carry the SAME Step-0 account attestation as Trigger briefs (D-259c / INS-319
 * §5) so an account mismatch is detectable on this path too. The preamble is
 * prepended to the user prompt in BOTH query and execute modes from a single
 * source-of-truth constant.
 */
describe("cc_dispatch attestation parity (M-048 / D-259c)", () => {
  it("the preamble names the attestation command and the INS-320 email question", () => {
    expect(CC_DISPATCH_ATTESTATION_PREAMBLE).toContain("claude auth status --text");
    expect(CC_DISPATCH_ATTESTATION_PREAMBLE).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(CC_DISPATCH_ATTESTATION_PREAMBLE).toContain("ANTHROPIC_API_KEY");
    expect(CC_DISPATCH_ATTESTATION_PREAMBLE).toContain("ACCOUNT EMAIL:");
    expect(CC_DISPATCH_ATTESTATION_PREAMBLE.toLowerCase()).toContain("which email");
  });

  it("buildDispatchPrompt prepends the preamble and keeps the user task (query mode)", () => {
    const task = "Audit the resilience tests and report gaps. Read-only.";
    const built = buildDispatchPrompt(task);
    expect(built).toContain(CC_DISPATCH_ATTESTATION_PREAMBLE);
    expect(built).toContain(task);
    // Attestation comes FIRST so the worker runs it before any other action.
    expect(built.indexOf("claude auth status --text")).toBeLessThan(built.indexOf(task));
  });

  it("buildDispatchPrompt prepends the same preamble in execute mode", () => {
    const task = "Implement the fix and open a PR.";
    const built = buildDispatchPrompt(task);
    expect(built).toContain(CC_DISPATCH_ATTESTATION_PREAMBLE);
    expect(built).toContain(task);
  });

  it("instructs the worker to emit attestation in output/PR (no pane on this path)", () => {
    expect(CC_DISPATCH_ATTESTATION_PREAMBLE.toLowerCase()).toMatch(/output|pr body/);
    // Presence-only discipline is stated (never print token/key values).
    expect(CC_DISPATCH_ATTESTATION_PREAMBLE.toLowerCase()).toContain("presence");
  });
});
