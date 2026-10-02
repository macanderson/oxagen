# restore_managed_block

Put Oxagen's managed block back in `AGENTS.md`, `CLAUDE.md`, or `README.md` on an open steering PR's branch, as one commit (#4518). The steering PR panel offers it as Restore block when the `owned` check finds a changed block. The six checks then run again on the new commit.

**Surfaces:** api, mcp, cli, agent

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/context/prs/restore-block`, which answers 200
- MCP: `restore_managed_block`
- CLI: `oxagen steering restore-block <proposal-id> <path>`
- App: Steering, the steering PR panel, Restore block beside a drifted managed block
- Authentication: org Owner or Admin, or workspace Owner or Member
- Not billed (`noBillingGate: true`), IAM default-deny, medium sensitivity
- Agent: Stella finds it with `search_tools` and loads it with `load_tools`. Each call waits for a person's approval (`riskLevel: medium`).

## Managed blocks

In a steering repo, `AGENTS.md`, `CLAUDE.md`, and `README.md` each hold a block that only Oxagen writes. The block sits between two marker lines:

```
<!-- oxagen:begin managed sha256:<hash> -->
The text Oxagen writes.
<!-- oxagen:end managed -->
```

The begin marker carries a hash of the block's text. The `owned` check fails a steering PR that edits the block, removes it, or deletes the file that holds it. Notes a team adds go below the end marker.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `proposalId` | `string` | The proposal whose steering PR holds the file (`prp_…`) |
| `path` | `AGENTS.md`, `CLAUDE.md`, or `README.md` | The file whose managed block to restore. The schema refuses any other path |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `commit_sha` | `string` | The commit that restored the block |
| `status` | proposal status | Where the six checks stopped on that commit, such as `checks_passed` or `checks_failed` |

## Semantics

Restore writes one commit on the steering PR's branch:

- The file keeps every line outside the block.
- The block becomes the one the production branch holds, with its markers and hash.
- A file the PR deleted comes back whole, as the production branch holds it.
- A block the PR removed goes back at the top of the file.

Text a person wrote between the markers on the branch is lost. To keep it, move it below the end marker before you restore the block.

The six checks then run again on the new commit, and `status` says where they stopped.

## Refusals

A refused call writes nothing.

| Reason | When |
| --- | --- |
| `proposal_not_found` | The workspace holds no proposal with this id |
| `governance_proposal` | The proposal changes the governance mode. [set_governance_mode](context.governance_mode.set.md) opens that PR and runs its checks |
| `proposal_merged`, `proposal_rejected` | The proposal already merged, or was dismissed |
| `pr_not_open` | The proposal has no steering PR yet, or its PR closed on the host |
| `repository_host_changed` | The PR was opened on one host, and the workspace's steering repo is now on another |
| `base_moved` | The PR no longer targets the production branch |
| `head_unknown` | The PR's branch is gone from the repository |
| `merge_in_progress` | A merge of the PR is still landing. Try again when it finishes |
| `head_moved` | The PR's branch moved to a new commit after Restore read it. Read the PR again and retry |
| `no_managed_blocks` | The repository is not a steering repo, so none of its files holds a managed block |
| `no_managed_block` | The production branch holds no managed block in this file, so there is no block to restore |
| `block_intact` | The block at the PR's head already matches the production branch |

`proposal_not_found` comes back with code `not_found`. Every other refusal comes back with code `conflict`, as in the other steering writes.
