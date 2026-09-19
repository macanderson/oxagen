# list_proposals

**Name:** `list_proposals`
**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low
**Billing:** `noBillingGate: true`
**Mutates:** no

## Intent

The workspace's record proposals with their support and, once a Context PR is open, its state ([ADR-061](../adr/ADR-061-steering-governance-mode-thresholds-and-the-reflector.md); MC spec §9.2). The read behind the Proposals and Context PRs tabs and the Steering nav count (proposals waiting for a person: `proposed`, `checks_passed`).

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `status` | `proposed \| pr_open \| checks_running \| checks_passed \| checks_failed \| merged \| rejected`? | |
| `lineageId` | `string`? | |
| `limit` / `offset` | `int` | 1–200, default 50 / default 0 |

## Output

| Field | Type | Source |
| --- | --- | --- |
| `proposals[].id` | `string` | `agent.context_proposals.public_id` (`prp_…`) |
| `proposals[].lineageId` / `.kind` / `.force` / `.constraintEffect` / `.sharingScope` / `.statement` / `.rationale` / `.source` | | The proposal as recorded |
| `proposals[].support` | `{ runs[], agents[], recordIds[], evidenceLinks[] }` | The support it cites |
| `proposals[].status` | the state machine | `context_proposals.status` |
| `proposals[].pr` | `{ number, url, repository, branch } \| null` | Null before `open_context_pr` |
| `proposals[].checks` | `{ passed, total } \| null` | The tally of the six checks; null before the PR is opened |
| `proposals[].createdAt` / `.updatedAt` | RFC 3339 | |
| `total` | `int` | The count ignoring paging |

## Semantics

Newest first. Workspace-bound.
