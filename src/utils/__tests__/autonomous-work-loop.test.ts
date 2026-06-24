import { describe, expect, it } from "vitest";
import {
  AUTONOMOUS_WORK_LOOP_VERSION,
  buildAutonomousWorkLoopPayload,
} from "../autonomous-work-loop.js";

describe("autonomous work loop payload", () => {
  it("defines the queue-autonomy contract Claude receives at bootstrap", () => {
    const payload = buildAutonomousWorkLoopPayload();

    expect(payload.version).toBe(AUTONOMOUS_WORK_LOOP_VERSION);
    expect(payload.default_mode).toBe("queue_autonomy");
    expect(payload.queue_sources).toEqual(
      expect.arrayContaining([
        "next_steps",
        "resumption_point",
        ".prism/task-queue.md",
        "open_prs_and_checks",
        "trigger_or_cc_dispatch_state",
        "opening_request",
      ]),
    );
    expect(Object.keys(payload.work_classes)).toEqual([
      "autonomous_now",
      "autonomous_with_review",
      "parallel_dispatch",
      "human_boundary",
    ]);
    expect(payload.work_classes.autonomous_now).toContain("repo-visible");
    expect(payload.work_classes.parallel_dispatch).toContain("parallel: true");
    expect(payload.dispatch_policy.trigger_default).toContain("Trigger");
    expect(payload.dispatch_policy.cc_dispatch_exception).toContain("efficiency, quality, or accuracy");
    expect(payload.dispatch_policy.parallel_trigger).toContain("parallel: true");
    expect(payload.dispatch_policy.status_polling).toContain("cc_status");
    expect(payload.dispatch_policy.trigger_recovery_stops).toContain("stale active slot");
    expect(payload.continue_until).toEqual(
      expect.arrayContaining([
        "human_boundary_reached",
        "verification_failed",
        "daemon_down_for_substantial_dispatch",
        "unresolved_model_disagreement",
      ]),
    );
    expect(payload.human_boundaries).toEqual(
      expect.arrayContaining([
        "production_deploy_config_or_live_service_behavior",
        "destructive_data_history_deletion_force_push_irreversible",
        "failed_verification",
        "unresolved_model_disagreement",
      ]),
    );
    expect(payload.verification_policy).toEqual(
      expect.arrayContaining([
        "Run task-appropriate tests before closure.",
        "Verify Trigger history git.pr_number, git.branch, git.merge_commit, and post_merge.actions_completed.",
        "Treat status: merged alone as insufficient proof of execution.",
      ]),
    );
    expect(payload.backward_compatibility).toContain("additive");
    expect(payload.rollback).toContain("revert");
    expect(payload.next_action_directive).toContain("begin");
    expect(payload.next_action_directive).toContain("without asking Brian");
  });
});
