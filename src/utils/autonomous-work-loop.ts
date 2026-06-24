export const AUTONOMOUS_WORK_LOOP_VERSION = "1.0.0";

export interface AutonomousWorkLoopPayload {
  version: typeof AUTONOMOUS_WORK_LOOP_VERSION;
  default_mode: "queue_autonomy";
  queue_sources: string[];
  work_classes: {
    autonomous_now: string;
    autonomous_with_review: string;
    parallel_dispatch: string;
    human_boundary: string;
  };
  dispatch_policy: {
    trigger_default: string;
    cc_dispatch_exception: string;
    parallel_trigger: string;
    status_polling: string;
    trigger_recovery_stops: string;
  };
  continue_until: string[];
  human_boundaries: string[];
  verification_policy: string[];
  backward_compatibility: string;
  rollback: string;
  next_action_directive: string;
}

export function buildAutonomousWorkLoopPayload(): AutonomousWorkLoopPayload {
  return {
    version: AUTONOMOUS_WORK_LOOP_VERSION,
    default_mode: "queue_autonomy",
    queue_sources: [
      "next_steps",
      "resumption_point",
      ".prism/task-queue.md",
      "open_prs_and_checks",
      "trigger_or_cc_dispatch_state",
      "opening_request",
    ],
    work_classes: {
      autonomous_now:
        "Reversible repo-visible docs, tests, helper scripts, checklists, issue/PR hygiene, small code fixes, and evidence-gathering work with clear verification.",
      autonomous_with_review:
        "Multi-file or runtime/template behavior changes that need a named scope, intended effect, rollback path, verification gates, and fresh adversarial review.",
      parallel_dispatch:
        "Independent work units dispatched through Trigger briefs with per-brief frontmatter parallel: true, or through the narrow cc_dispatch exception when justified.",
      human_boundary:
        "operator-only work: credentials, spending, production/live service changes, destructive history or data operations, external/legal communications, active Claude.ai settings, high-risk unreviewed runtime behavior, live MCP/Trigger/CI config, stale/failed dispatch state, failed verification, or unresolved model disagreement.",
    },
    dispatch_policy: {
      trigger_default:
        "Trigger is the mandatory default for dispatched Claude Code work.",
      cc_dispatch_exception:
        "Use cc_dispatch only after stating the task-specific efficiency, quality, or accuracy advantage.",
      parallel_trigger:
        "Use per-brief frontmatter parallel: true only for independent work; marker fields intra_project_parallel and max_parallel_briefs are cosmetic.",
      status_polling:
        "Poll async cc_dispatch with cc_status and verify Trigger state/history for Trigger briefs.",
      trigger_recovery_stops:
        "A stale active slot, daemon-down condition, or missing Trigger enrollment stops substantial dispatch until recovery or operator action.",
    },
    continue_until: [
      "queue_empty",
      "human_boundary_reached",
      "verification_failed",
      "stale_trigger_active_slot",
      "daemon_down_for_substantial_dispatch",
      "unresolved_model_disagreement",
      "context_or_session_finalization_required",
    ],
    human_boundaries: [
      "credentials_secrets_tokens_keychains_account_identity",
      "payment_spending_billing",
      "production_deploy_config_or_live_service_behavior",
      "destructive_data_history_deletion_force_push_irreversible",
      "legal_compliance_customer_vendor_external_communications",
      "direct_active_claude_project_setting_edits",
      "high_risk_prism_runtime_behavior_without_reviewed_plan",
      "mcp_trigger_ci_live_configuration_changes",
      "stale_trigger_active_slot",
      "daemon_down_substantial_dispatch_attempt",
      "failed_verification",
      "unresolved_model_disagreement",
    ],
    verification_policy: [
      "Run task-appropriate tests before closure.",
      "Verify Trigger history git.pr_number, git.branch, git.merge_commit, and post_merge.actions_completed.",
      "Treat status: merged alone as insufficient proof of execution.",
      "Checkpoint durable PRISM state before continuing after a significant milestone.",
    ],
    backward_compatibility:
      "This field is additive; older clients that ignore autonomous_work_loop still follow behavioral_rules Rule 2A.",
    rollback:
      "Revert the autonomous_work_loop MCP server commit or PR to remove this field; framework rollback is reverting the 2.25.0 template PR.",
    next_action_directive:
      "After boot, classify the queue and begin autonomous_now or eligible parallel_dispatch work without asking Brian when repo-visible safe work exists.",
  };
}
