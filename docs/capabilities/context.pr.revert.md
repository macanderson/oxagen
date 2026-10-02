# revert_steering_pr

**Name:** `revert_steering_pr`
**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent, cli
**Agent:** Stella finds it with `search_tools` and loads it with `load_tools`. Each call waits for a person's approval (`riskLevel: high`).
**Risk level:** high (requires approval on the agent surface)
**Billing:** `noBillingGate: true`
**Mutates:** yes. It writes a branch and opens a pull request. It merges nothing.
**Roles:** the roles of [`merge_context_pr`](context.pr.merge.md), then the governance mode's merge rule. The handler checks both (INV-29).

## Intent

Revert opens a steering PR that undoes a merged one (#4449; steering repo spec, Steering PR flow).

1. The handler reads the merged proposal. It needs the proposal's pull request number, its branch, and its merge commit. When Oxagen did not record the merge commit, the handler reads it from the host.
2. It reads the merge commit's first parent. That parent is what the production branch held just before the merge.
3. It writes every path the merge changed back to the parent's version, in one commit on a new branch. A file the merge added is deleted. A file the merge changed or removed gets its old content back.
4. It opens the pull request into the production branch. The title is `Revert steering PR #<number>`.

The branch keeps the folder prefix of the merged PR's branch: a revert of `steering/<lineage>` goes on `steering/revert-<number>`, and a revert of `memory/<lineage>` goes on `memory/revert-<number>`.

The ledger under `steering/promotions/` stays as it is. The ledger only grows, so the line the merge added stays. When the revert PR merges through the queue, its own stamp adds the line that records the undo.

In a steering repository, Oxagen runs the steering checks on the revert's head against the production branch. It reports the result as the required `Oxagen steering` check, the same check a tools steering PR gets. A check that cannot run is reported as a failure that says why. A legacy repository has no required check, so nothing is reported there.

The revert PR waits for review. Its merge follows the approval rules of the workspace's governance mode.

In a steering repository the revert PR carries a proposal of kind `revert` ([ADR-265](../adr/ADR-265-every-steering-pr-oxagen-opens-carries-a-proposal-row.md), #5122). The answer names it as `revertProposalId`, and [`merge_context_pr`](context.pr.merge.md) lands it through the merge queue. A revert of a record PR takes the record's lineage, so its merge retires the record when the revert deleted the record's file. A revert of any other steering PR, such as a tools or memory PR, takes its own branch as its lineage.

## Who may revert

A revert is a merge-class action. The caller first needs one of the contract's roles: an org Owner or Admin, or a workspace Owner or Member. Then the governance mode on the production branch decides, as it does for a merge:

| mode | who reverts |
| --- | --- |
| `solo` | any workspace member, and an org Owner or Admin |
| `team` | an org Owner or Admin, or a workspace Owner |
| `regulated` | an org Owner or Admin |

There is no separation-of-duties check here. The caller opens the revert and does not approve it, so the author of the merged PR may revert it too. A revert opens a PR and records no approval, so `merge_pr_without_review` changes nothing about who may revert.

An API key acts as its creator, with the creator's current roles. That is why this capability is on the MCP and CLI surfaces, while `merge_context_pr` is not: a merge records its merger as the reviewer, and a key cannot stand in for one.

## Limits

- A governance proposal is refused. The governance mode changes only through [`set_governance_mode`](context.governance_mode.set.md) ([ADR-232](../adr/ADR-232-a-steering-repositorys-governance-mode-changes-through-a-steering-pr.md)). Set the mode again to change it back.
- In a legacy repository the revert PR carries no proposal. It merges on the host, and the repository sync reads the merge.
- A revert of a record PR is refused `lineage_pr_open` while another PR on that record is open: one concern, one pull request.
- One revert at a time for each merged PR. While the revert branch exists, a second call is refused `revert_branch_exists`.

## Input

`{ proposalId: prp_… }`, the merged proposal.

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `proposalId` | `string` | The merged proposal |
| `reverted` | `{ number, mergedCommit }` | The merged steering PR and the merge commit the revert undoes |
| `pullRequest` | `{ number, url, branch, headSha }` | The revert PR. `headSha` is the revert branch's head, or null when the host did not say |
| `check` | `"success"`, `"failure"`, or `null` | The `Oxagen steering` check on the revert's head. Null in a legacy repository, and null when the host refused the report |
| `revertProposalId` | `string` or `null` | The proposal that carries the revert PR, which `merge_context_pr` merges. Null in a legacy repository, and null when Oxagen could not record it |

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `no_principal` | The call carries no user, and no API key with a creator. Nothing is read. |
| `forbidden` | `org_role_required` | The caller holds none of the contract's roles, or the governance mode does not let the caller merge. Nothing is opened. |
| `not_found` | `proposal_not_found` | The workspace has no such proposal. |
| `conflict` | `governance_proposal` | The proposal changed the governance mode. Set the mode again instead. |
| `conflict` | `not_merged` | The proposal's PR has not merged. Only a merged steering PR can be reverted. |
| `conflict` | `pr_not_recorded` | The proposal has no recorded pull request. |
| `conflict` | `repository_host_changed` / `repository_changed` | The PR merged on another host or in another repository than the one the workspace steers through now. Revert it there by hand. |
| `conflict` | `governance_unreadable` | The governance file on the production branch cannot be read, so the mode's rule cannot be applied. |
| `conflict` | `merge_commit_unknown` | Neither Oxagen nor the host names the merge commit, or the commit has no parent. |
| `conflict` | `nothing_to_revert` | The merge changed nothing outside the ledger. |
| `conflict` | `lineage_pr_open` | Another PR on the reverted record is open. Merge or close it, then revert. Nothing is opened. |
| `conflict` | `revert_branch_exists` | A revert branch for this PR already exists. Merge or close its pull request, delete the branch, and revert again. |
| `conflict` | `production_branch_missing` | The repository has no production branch. |
| `conflict` | `github_refused` / `gitlab_refused` | The host refused a read or a write. |
