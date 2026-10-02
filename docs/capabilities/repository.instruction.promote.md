# promote_instruction_to_steering

Turn one instruction-file statement that contradicts a steering record into a proposal for a new version of that record, and open the proposal's steering PR (#4518, [ADR-263](../adr/ADR-263-code-repository-findings-are-stored-when-the-check-runs.md)). Pass a finding's id from [list_code_repository_findings](repository.findings.list.md). Nothing steers an agent until the steering PR merges.

**Surfaces:** api, mcp, cli

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/repository/findings/promote`, which answers 201
- MCP: `promote_instruction_to_steering`
- CLI: `oxagen steering promote <finding-id>`
- App: Repositories, Promote to steering beside a finding in the Instruction files section
- Authentication: org Owner or Admin, or workspace Owner or Member
- Not billed (`noBillingGate: true`), IAM default-deny, medium sensitivity
- Not on the agent surface.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `finding_id` | `string` | The finding's id (`crf_…`) from list_code_repository_findings. The schema refuses any other id, such as a repository's `rpb_…` |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `proposal_id` | `string` | The proposal it opened (`prp_…`) |
| `lineage` | `string` | The record the proposal revises. A lineage is the name every version of a record shares |
| `status` | proposal status | Where the steering PR stopped when the call returned: `proposed`, `pr_open`, `checks_running`, `checks_passed`, `checks_failed`, `merged`, or `rejected` |
| `pull_request` | `{ number, url }` or null | The proposal's steering PR, or null when it has none |

## Semantics

Only a contradiction can be promoted. Promote reads the finding and compares its statement with the workspace's active records again, with the same test the `Oxagen` check uses. A record revised or retired since the check ran changes the answer.

The proposal is a new version of the record the statement contradicts:

- The statement becomes the record's text.
- The pull request and the file line become its evidence.
- The record keeps its lineage, kind, force, and scope.
- A constraint takes its effect from the statement's words. A statement with "never", "do not", "must not", "avoid", or the like forbids. Any other statement requires.

Promote opens the proposal's steering PR at once, and the PR runs the six checks. `status` says where they stopped. The new version steers no agent until that PR merges. After the call, list_code_repository_findings returns the proposal as the finding's `proposal`.

A promoted statement can hold up to 2,000 characters. The check stores up to 4,000 characters of a statement, so a stored finding can be too long to promote. To promote it, shorten the line in the instruction file first.

## Refusals

Every refusal comes before the proposal is written, so a refused call writes nothing.

| Reason | When |
| --- | --- |
| `finding_not_found` | The workspace holds no finding with this id, or no longer links the finding's repository |
| `finding_resolved` | The statement matches no active record now, because a record was revised or retired after the check ran |
| `already_in_steering` | The statement repeats a record, so steering already says it |
| `already_proposed` | A proposal opened from this finding is still open. A dismissed or merged one does not refuse |
| `statement_too_long` | The statement is over 2,000 characters |
| `record_not_proposable` | The record is a kind a statement cannot revise, such as a skill |
| `lineage_pr_open` | Another steering PR is open on the record. Merge or dismiss it first |

`finding_not_found` comes back with code `not_found`. Every other refusal comes back with code `conflict`.

The finding names its proposal before the steering PR opens. If the PR then fails to open, the proposal stays, and a person opens it from the Steering page. A second promote is refused `already_proposed` and does not propose the line twice.
