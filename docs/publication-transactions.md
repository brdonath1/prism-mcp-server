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
