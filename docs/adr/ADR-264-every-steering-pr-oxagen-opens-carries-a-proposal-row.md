# ADR-264: Every steering PR Oxagen opens carries a proposal row

- **Status:** Accepted
- **Date:** 2026-10-02
- **Owners:** steering
- **Extends:** ADR-232 (a proposal that publishes no record)
- **Related:** issue #5122, issue #5149, issue #5134, issue #5139,
  `packages/handlers/src/steering-repo/pr-proposal.ts`,
  `packages/handlers/src/context.pr.merge.ts`,
  `packages/handlers/src/tools.pr.open.ts`.

## Context

A steering repository has one merger: Oxagen. A person who merges a steering
PR on the host leaves the production branch holding a commit Oxagen did not
merge, and the repository's health reads `diverged`. Oxagen merges only
through `merge_context_pr`, and that capability lands a PR only from a row in
`agent.context_proposals`.

Until now only two kinds of steering PR had a row: a record PR from
`open_context_pr`, and a governance PR from `set_governance_mode` (ADR-232).
Every other steering PR Oxagen opened had none, so nothing in Oxagen could
merge it:

- the revert PR `revert_steering_pr` opens
- the tools PRs from Studio's Review, the server sync (M10), and the server
  folder writer (M13)
- the Markdown import PR
- the memory PRs the curator and `promote_memories` open
- the PRs `import_workspace_steering` opens when it moves `.oxagen/` to a new
  steering repo
- the `workspace.toml` PR `link_repository` and `unlink_repository` open

The MCP Studio live test (#5139) stops at its first merge for this reason.
On 2026-10-02 the app told Mac to merge his gtm workspace's two import PRs on
GitHub. He did, and the repository read `diverged`, with a Repair that would
revert the import.

Two designs were open: give each of these PRs a proposal row, or add a merge
capability keyed by PR number. Mac chose the first on 2026-10-02 and rejected
the second.

## Decisions

### 1. Each opener writes a proposal row of its PR's kind

`context_proposals.kind` gains seven values for PRs that change files rather
than one record: `revert`, `tools`, `import`, `memory_pr`, `agent_file`,
`agent_proposal`, and `workspace`. `import` covers both imports: the Markdown
import's PR and each steering PR the `.oxagen/` import opens. `memory_pr` is
the memory PR on `memory/<date>`. It is spelled apart from `memory`, which
stays the record kind. `workspace` is the `workspace.toml` PR that links or
unlinks a code repository. `agent_file` is the PR enrollment opens for a
host's agent file (#5149). `agent_proposal` is the PR `propose_steering`
opens (#5134). Both are in the enum now, so neither needs a migration of its
own.

The opener writes the row once the host has opened the PR and the opener has
reported its "Oxagen steering" check, in `recordSteeringPrQuietly`
(`steering-repo/pr-proposal.ts`). The row holds:

- `kind`: the PR's kind.
- `lineage_id`: the PR's branch. A branch name holds a `/`, and a record's
  lineage cannot, so the two never meet. A revert of a record PR is the one
  exception: it takes the record's lineage (decision 4).
- `path`: the folder every changed file sits under, such as
  `tools/servers/billing`, or `.` when the files share none.
- `statement`: the PR's title. `force` is `info` and the scope is the
  workspace, as on a governance row. A steering PR publishes no single
  record, so these fields name none.
- `status`: `checks_passed` or `checks_failed` from the opener's check, or
  `pr_open` when no check ran. `checks` is empty: the six record checks do not
  apply.
- `created_by_id` and `source`: the person who opened it, or the job, such as
  `mcp-studio-sync` or `memory-curator`.

A commit the opener adds to an open PR moves the row to the new head. An open
row on the same branch for another PR is set aside, because the host keeps one
open PR per branch, so that PR was closed and the repository sync has not read
the close yet.

The shared opener in `tools.pr.open.ts` takes the row's kind from a required
`proposalKind` on `SteeringPullRequestKind` and its store from a required
`proposals` dependency. A new kind of PR on that opener cannot compile without
naming its row's kind, which is how `propose_steering` (#5134) gets its row.

A row that fails to write is logged, and the open succeeds. The PR exists, and
its caller keeps its number. Throwing would leave the caller behind a branch it
can no longer open. The next commit the opener adds to the PR writes the row.

### 2. The merge runs the steering checks itself

`merge_context_pr` lands a steering PR proposal from any open status:
`pr_open`, `checks_running`, `checks_passed`, or `checks_failed`. It runs the
steering checks on the head the row names, against the production head, and
reports them as the "Oxagen steering" check, as a governance merge does. A
failure moves the row to `checks_failed` and merges nothing.

The opener's own report is not the gate. It compared the PR against the
production branch of its moment, and a memory PR opens with no check at all.
No webhook runs the checks again after a push, so the merge is the one place
that always sees the head that would land.

`open_context_pr` refuses a steering PR proposal with `steering_pr_proposal`.
It runs the six record checks, which do not apply.

### 3. The merge path is the record PR's, without a record

A steering PR proposal lands through the same merge queue, reviewer rule
(`mergeRefusal`), merge claim, approvals (`mergeApproval`), branch update and
re-check, stamp, and trailers as a record PR (`landSteeringPr`). It reads no
record body, so it never refuses `record_file_missing`. Once merged, publish()
makes the production branch the next steering version, and the merge emits
`steering.published`. The output is the steering PR arm of
`merge_context_pr`'s union: the PR's number and branch, and the records a
revert retired.

A PR someone merged on the host carries no merge claim. The merge asks the
repository sync to read it and refuses `merged_outside_oxagen`, as a
governance merge does. A record PR is more lenient, because its row names the
record that publishing fills in. A steering PR's row names nothing a later
call could finish.

A head the host moved is refused `head_moved`, as for a record PR. The
repository sync and `refresh_context_pr` move the row to the host's head. A
steering PR row at `pr_open` follows the head too, because it rests there,
which a record row never does. The next merge checks the new head.

The merges are in the steering layout only. Every opener but the revert
already refuses a legacy repository. A revert in a legacy repository writes no
row: its merge lands on the host, and the repository sync reads it, as before.

### 4. A merged revert retires the record its merge deleted

A revert of a record PR takes the record's lineage and path. So the open-PR
index refuses a revert while another PR on that record is open, which the
revert handler checks first and refuses as `lineage_pr_open`.

When the revert merges, the merge reads the record's current path at the merge
commit. If the registry holds the record active and the file is gone, the
record retires in the same transaction that moves the row to `merged`: its
status becomes `retired` at the merge commit, and a `retire` promotion event
joins its chain with the merger as approver. This is the write the repository
sync makes for a deleted file in the legacy layout.

A revert of a tools, import, memory, or other steering PR takes its own branch
as its lineage and retires nothing. In the steering layout the registry holds
only records a Context PR published, so no other PR put a record there to take
back.

`revert_steering_pr` answers the revert row's id as `revertProposalId`, so the
caller can merge it.

## Consequences

- Every steering PR Oxagen opens can land through the queue, the stamp, and
  the ledger. A workspace no longer has to merge on the host and read
  `diverged`.
- The app lists these PRs with the record and governance PRs and offers Merge
  on each.
- A steering PR someone already merged on GitHub stays outside Oxagen.
  `diverged.ts` trusts on GitHub only a merge the steering app's bot made, so
  the gtm workspace's import PRs, merged by hand before this decision, keep
  the repository `diverged`, and its Repair would revert them. Nothing here
  adopts such a merge. #5195 gives a person a recorded way to adopt it.
- A revert that restores an earlier version of a record leaves the registry on
  the reverted version. The steering version, which runs read, holds the
  restored file. Making the registry follow means promoting the earlier
  version again, which this decision leaves for later.
