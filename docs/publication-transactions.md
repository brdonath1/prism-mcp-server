# Transactional knowledge publication

PRISM preserves portable project knowledge; publication must not make related
document changes visible in partially applied states. The first simplification
unit batches pending document updates without changing native session behavior,
tool authorization, synthesis routing, or CI policy.

## Pending-update transaction

One pending-update application prepares the changed target documents, the
provenance archive, and the consumed-batch marker together. It publishes them in
one atomic Git commit. Sanitization, section boundaries and integrity validation
run before publication. An operational or integrity error leaves the batch and
every target unchanged; results must not report applied/archived/cleared on a
failed commit. Explicitly rejected proposals retain provenance.

The archive retains the exact source batch, its SHA-256 and snapshot revision;
the clear marker references that digest. New synthesis stamps transaction-v1
eligibility in server code. Unmarked nonempty legacy batches are deferred for
reconciliation, because the former sequential publisher may have applied some
targets before failing. Automatic post-finalization synthesis does not replace
a batch whose application returned errors. Explicit manual synthesis remains an
operator-requested replacement operation; reconcile retained proposals first.

The safe-mutation primitive captures the repository HEAD before reading and
computing content. The Git publisher refuses a different HEAD before creating
the tree. The final ref update is non-forced, protecting the remaining race.
A conflict retries with fresh content; unknown HEAD prevents any mutation.
Reads are pinned to the captured revision. Structural lost-response verification
checks the attempted commit's reachability and content even if a newer writer
has advanced the branch; unverifiable outcomes refuse a blind retry.

This removes separate target/archive/clear commits for one pending batch. It
does not combine finalization, backup retention, and later AI synthesis into a
single transaction, and does not promise two commits for an entire session.

## Scope and rollout

Before this change, production reported 4.15.0 and GitHub deployment 6466502605
reported success for commit 1ad20b756397623d39a8b058563149a562bc99ce.
Use the existing protected PR/CI path and existing main-connected Railway
deployment. Do not provision another service or change credentials. The generic
`apex-deploy --dry-run` cannot map this older service because it lacks
`.metaswarm/stream`; it is not the deployment mechanism for this change.

Validate atomic success, multi-document failure, concurrent updates, uncertain
responses, sanitization, provenance and legacy document paths in mocked local
tests. Run existing required CI. Deployment status plus health establishes
release availability, not live finalization correctness. Confirm publication
count and resumption correctness at the next normal finalization; do not invoke
production finalization merely to benchmark it. Roll back through a revert PR,
never by force-pushing or deleting project history.

## Subsequent simplification boundaries

- Establish one published project checkpoint contract, with compatible reads of
  historical `.prism/` and dated handoff records before retiring any authority.
- Keep private crash recovery and provider-specific lifecycle receipts separate
  from published project knowledge. Never infer native closure from publication.
- Reconcile stale numbering/finalization instructions at their source and
  installers, preserving explicitly selected behavior and account isolation.
- Make routine knowledge maintenance proportional to changed content, preserving
  security and domain-specific review requirements.
- Identify actual optional integration usage before separating tool exposure;
  source registration does not establish deployed usage.

These are subsequent migration units, not functionality delivered by the
pending-update transaction. No new framework, database, scheduler, runner or
paid service is required for this first unit.

## Published checkpoint reader (4.15.2)

Bootstrap now exposes `published_checkpoint`, `checkpoint_authority`, and a
`checkpoint_contract` describing precedence. It reads `docs/handoffs/LATEST.md`
and its named dated handoff at one captured main-branch revision. A verified
published handoff takes precedence over native `current_state`,
`resumption_point`, and `next_steps`; native version/session metadata remains
available for existing consumers. A missing pointer or explicit `handoff: none`
retains native compatibility fallback for older projects. The separately read native
content is not snapshot-verified against the pointer revision; the response
labels this `native_compatibility_handoff`. A malformed pointer, missing target,
unknown revision, or unavailable read reports unverified authority and requires
reconciliation; it never silently promotes stale native work instructions.

The complete checkpoint body is capped at 24 KiB. Larger checkpoints require an
explicit fetch/reconciliation rather than silently truncating important context.
Content remains project data, never authorization or a native lifecycle command.
The pointer is verified against its target, not independently against the history
of every dated handoff: existing pickup instructions still require that history
check. Publication during the read cannot mix pointer and target revisions.

This is the reader migration. Existing writers and native handoff schema are
unchanged; older clients may ignore the additive fields. Removing duplicate
writers or claiming fleet-wide handoff consolidation requires a separate rollout
and observation of each consumer. No session is created, renamed, archived or
reconfigured by this change.

## Compatibility preparation (4.15.3)

`prism_finalize action=prepare_checkpoint` derives a compact native handoff from
an already-published canonical checkpoint. It is a read-only action: no backup,
prune, synthesis, draft persistence, Git write or native lifecycle operation runs.
It returns `path`, `content`, `source`, and `native_template_version`, with
`writes_performed: false`, `finalized: false`, and `publication_required: true`.
The output is a candidate; preparation does not publish it or complete a session.

First publish the dated handoff and LATEST pointer together through the existing
repository PR/checks contract. Reconcile the newest handoff by Git history, as
required by the repository's pickup rules. Then provide:

```json
{
  "project_slug": "example",
  "action": "prepare_checkpoint",
  "session_number": 4,
  "handoff_version": 8,
  "expected_published_handoff": {
    "ref": "<full current main commit SHA>",
    "path": "docs/handoffs/handoff-2026-09-23-0900.md",
    "sha": "<full Git blob SHA for that dated handoff>"
  }
}
```

The server verifies main before and after reads, reads LATEST and its complete
canonical target at that immutable commit, and requires the expected path/blob.
It reads existing native handoff metadata at the same commit, preserves the
native template version and file location (including historical root layouts),
and refuses unavailable metadata. The candidate retains the native schema and
explicitly points consumers to the complete canonical handoff. It does not copy,
truncate, summarize or independently re-author its work-state narrative. Existing
clients must follow that reference before acting; automatic client adoption is
not established by the new action.

The source argument is accepted only for preparation. Passing it to commit/full
is rejected before any writes, so it cannot imply a source-guarded commit that
the existing writer does not implement. Review the candidate and reverify its
source and historical freshness immediately before the existing authorized
publication workflow. A prepared candidate does not reserve a branch or prevent
a later concurrent update. Re-prepare after main changes; an old response is not
proof of present freshness. Preparation itself checks pointer/target agreement,
not the historical ordering of every dated handoff. Existing hook-only write
restrictions, PR requirements and other repository permissions still apply.

Existing audit/draft/commit/full inputs and behavior remain compatible. This
step removes the need to compose a second handoff narrative when the candidate
is adopted; it does not yet consolidate publication transactions or establish
fleet adoption, measured speed/cost savings, or full writer migration.
