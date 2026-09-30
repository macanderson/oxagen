# ADR-232: A steering repository's governance mode changes through a steering PR

- **Status:** Accepted
- **Date:** 2026-09-30
- **Owners:** steering
- **Amends:** ADR-133 (the routes, for a steering repository)
- **Related:** issue #4766, issue #4795, issue #3859, PR #4788,
  `packages/handlers/src/steering-repo/governance-mode.ts`,
  `packages/handlers/src/context.pr.merge.ts`.

## Context

A steering repository keeps its governance mode as the top-level `mode` key of
`steering/governance.toml`. ADR-133 decides the route a change takes from the
mode in force: solo lands at once, and team or regulated waits for review,
unless the caller takes Apply now, which is recorded as an override. ADR-133
wrote the file for the legacy layout, where landing at once is a commit to the
production branch and the review is an ordinary pull request a person merges
on GitHub.

A steering repository admits neither. Oxagen is its only merger (ADR-228's
merge ruleset), every change to it goes through the steering merge queue, and
every merge stamps a ledger line that names who approved it. #4788 moved
`set_governance_mode` onto a steering PR and cited this decision as ADR-229
before the number went to #4202. That number never held it, so the code cited
a record that did not exist until this one.

After #4788 the review route opened a PR that nothing in Oxagen could land.
`merge_context_pr` lands a steering PR from a proposal row, and a governance
change had none. The only way to land it was Apply now, which records that
nobody reviewed it.

## Decisions

### 1. Every route opens a steering PR on `steering/governance`

`set_governance_mode` rewrites only the `mode` line of
`steering/governance.toml`, checks the result as governance/v1 before any
write, and pushes it to `steering/governance`. An open PR on that branch is
reused. Oxagen runs the steering checks on its head and reports the required
`Oxagen steering` check there. Nothing commits to the production branch.

### 2. Solo and Apply now land through the merge queue

Solo needs no review, so the caller is the approver. Apply now in team or
regulated is the override ADR-133 names: the ledger line says
`without_review: true`, and the call emits `steering.governance_overridden`
beside `steering.governance_changed`.

### 3. The review route is a governance proposal that `merge_context_pr` lands

The review route writes a `context_proposals` row of kind `governance` on the
fixed lineage `governance`, with the PR, its head, and whether the steering
checks passed. The open-PR index allows one per workspace. A later call sets
aside the open one, because the reused PR now carries the later change and its
author.

`merge_context_pr` lands the row through the same queue, reviewer rule, claim,
and approvals as a record, with these differences:

- The check is governance/v1 on the file plus the steering checks, run on the
  head that would merge and again after each update. The six record checks do
  not apply, and `open_context_pr` refuses a governance row.
- The merge needs an approval by a workspace member other than the author.
  Ownership and `merge_pr_without_review` do not land one without review, and
  `merge_pr_without_review` refuses a governance row. Apply now is the only
  route with no review, and it is recorded as the override.
- The merge publishes no record and appends no promotion event.
  `context_promotions` keeps one hash chain per record, and its `record_id` is
  NOT NULL. The approver is on the ledger line's `Oxagen-Approved-By`
  trailer, on the row's `merged_by_user_id`, and on
  `steering.governance_changed`, whose detail lists `approvedBy`.
- The output is the governance arm of a union on `kind`: the mode and the
  file, the merge commit, and the steering version.

`context_proposals_merged_check` admits a merged governance row that carries
only its merge commit, so the repository sync can also record a governance PR
someone merged outside Oxagen (#4795).

The lineage id `governance` is reserved. `lineageIdSchema` refuses it for a
record proposal, because a record on it would share the one governance PR slot
the open-PR index gives each workspace.

### 4. The repository sync records a governance change that landed outside Oxagen

The branch rules let only the Oxagen GitHub App update `main` (ADR-228). If
they drift, a reviewer can merge the governance PR on the host, or someone can
push straight to `main`. Health then reads `diverged`, but the new mode is in
force at once, because every call reads it from the production head.

Added on 2026-09-30. When the production head moves, the sync reads the mode in
`steering/governance.toml` at the last synced head and at the new one. A
different mode on a commit Oxagen did not merge landed outside Oxagen.
`landSteeringPr` writes an `Oxagen-Version` trailer on every merge, and
`set_governance_mode` and `merge_context_pr` land every governance change
through it and record their own events. Anyone who can push can write that
trailer too, so the sync counts it only when Oxagen's records hold the commit:
a governance proposal Oxagen merged names it, or the steering version store
holds it at the trailer's version. So the sync records only the changes
nobody else records, and a forged trailer does not hide one.

A governance PR someone merges on the host is not finished by
`merge_context_pr`. It resumes a merged PR only when an earlier call's merge
claim shows Oxagen started the merge. Otherwise it refuses
`merged_outside_oxagen` and asks for the sync, which records the change with
no approver.

- A governance PR merged on the host reads `merged` with its merge commit and
  no approver, and the sync deletes its branch.
- The sync emits `steering.governance_changed` with a null actor, the commit,
  both modes, and `landedOutsideOxagen: true`. It names the proposal when a
  governance PR carried the commit.
- It also emits `steering.governance_overridden` when the mode it replaced
  asked for review, which is every mode but `solo`. `set_governance_mode`
  emits both events for Apply now for the same reason: "every governance
  change" and "every skipped review" each stay one event-type filter. The
  review route through `merge_context_pr` still emits only the change.
- The sync compares modes, not files. A file missing or unreadable at either
  head is a layout change or a file problem, which the checks and health
  report. Two changes between syncs that end at the mode they started from
  record nothing.

## Consequences

- A reviewed governance change has a land path, and its approver is on record.
- `ProposalKind` is `RecordKind` plus `governance`. Every reader of a record
  keeps `RecordKind`. The proposal views, `list_proposals`, `get_context_pr`,
  and the app's proposal list and PR panel take `ProposalKind`, and a merged
  governance PR names no promotion event and no record.
- The repository sync records a governance PR merged on the host, and any
  other mode change Oxagen did not make, as decision 4 sets out.
- `set_governance_mode` answers `proposalId` for a proposed change in a
  steering repository, and the app links it to the Context PR panel where a
  reviewer lands it.

## Alternatives considered

- **Append a promotion event for a governance merge.** It needs
  `context_promotions.record_id` nullable, which breaks the one-chain-per-record
  shape every chain reader assumes. The ledger line already names the approver.
- **Let an owner land a governance PR without review, as for a record.** That
  is Apply now under another name, without the override record ADR-133 exists
  to leave.
- **A new event type for a change outside Oxagen.** It would add a third
  filter a reader must know to join, and "every governance change" would miss
  rows. `landedOutsideOxagen` on the existing event marks the source instead.
- **Tell Oxagen's merges apart by the rows and versions it wrote.** A publish
  can fail after the merge, and the sync's own publish then versions whatever
  head it reads, so neither table separates Oxagen's merges from a push. The
  trailer is on the commit itself.
