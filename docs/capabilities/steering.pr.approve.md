# approve_steering_pr

**Name:** `approve_steering_pr`
**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api
**Why no MCP, CLI, or agent:** The approver is a person signed in to Oxagen. An API key, which the MCP server and the CLI send, acts as the person who made it, so a key an agent holds could approve a change the agent proposed. The handler refuses every API-key call and every call with no signed-in user (`no_principal`), and an agent run (`agent_run`). The in-app assistant does not get it either, for the reason in [ADR-175](../adr/ADR-175-approvals-and-consent-are-off-the-agent-surface.md): a review is a person's decision.
**Billing:** `noBillingGate: true`
**Mutates:** yes
**Roles:** org Owner or Admin, or workspace Owner or Member (`defaultEffect: deny`), checked by the handler.

## Intent

Under the `team` and `regulated` governance modes, [`merge_steering_pr`](steering.pr.merge.md) lands a steering PR only after a workspace member other than the author approves it at the head that merges. This capability records that approval in Oxagen ([ADR-267](../adr/ADR-267-a-steering-pr-approval-is-stored-in-oxagen.md)).

The Oxagen GitHub App opens every steering PR, and GitHub refuses an app's approving review of a pull request it opened. So the approval is a row in `agent.steering_pr_approvals`, at the PR's head commit. The merge counts these rows beside the approvals on the host, under the same rule:

- The approval is at the head that merges, or at a head the merge queue brought up to date from it.
- The approver is not the author.
- The approver still holds a role in the workspace, or is an org Owner or Admin, when the merge runs.

A person who approved on the host and in Oxagen counts once. The `Oxagen-Approved-By` trailer and the promotion line name every approver the merge counted.

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/steering/prs/approve`, returns 200
- App: Steering › the steering PR page, the Approve button under the `team` and `regulated` modes

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `proposalId` | `prp_…` | The proposal whose steering PR is approved |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `proposalId` | `string` | |
| `headSha` | `string` | The head the approval is for: the commit the checks ran on. A push to the branch makes the approval stale |
| `approvals` | `int` | How many people approved this head in Oxagen, this approval included |

## Semantics

1. The handler refuses an agent run and any call that is not a person's session, an API-key call included, then checks the contract's roles.
2. It refuses a proposal the workspace does not hold, a merged or dismissed proposal, and one whose steering PR is not open yet.
3. It refuses the proposal's author. The merge would not count the author's approval.
4. It reads the PR on the host once. A PR the host merged or closed is refused (`pr_closed`), and so is a head that moved after the checks ran. Run the checks again with [`open_steering_pr`](steering.pr.open.md), then approve the new head.
5. It records the approval at the head. Approving the same head again records nothing new.

No governance mode is refused. The mode on the proposal is the one read when the PR opened, and the merge reads the mode again. An approval given under `solo` still counts if the mode is `team` when the merge runs.

[`get_steering_pr`](steering.pr.get.md) answers the count of approvals recorded in Oxagen at the head, as `approvals`.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `no_principal` | The call is an API-key call or carries no signed-in user. Nothing is read. |
| `forbidden` | `agent_run` | An agent run made the call. Nothing is read. |
| `forbidden` | `author_cannot_approve` | The caller raised the proposal. |
| `not_found` | `proposal_not_found` | The workspace holds no such proposal. |
| `conflict` | `proposal_merged`, `proposal_rejected` | The proposal is merged or dismissed. |
| `conflict` | `pr_not_open` | The proposal has no open steering PR yet. |
| `conflict` | `pr_closed` | The host merged or closed the pull request. |
| `conflict` | `head_moved` | The PR's head is not the commit the checks ran on. |
| `conflict` | `repository_host_changed` | The PR is on another host than the workspace's repository. |

The approval row is the record of who approved which head and when, and the merge's ledger line and trailer name every approver it counted. The kernel's `capability.invoke_*` audit records the call.
