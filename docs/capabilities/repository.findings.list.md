# list_code_repository_findings

List the instruction-file statements in the workspace's linked code repositories that repeat or contradict an active steering record. The Repositories page shows them in its Instruction files section (#4518, [ADR-263](../adr/ADR-263-code-repository-findings-are-stored-when-the-check-runs.md)). It writes nothing and runs no model.

**Surfaces:** api, mcp, cli, agent

## Surface

- API: `GET /v1/:org_slug/:workspace_slug/repository/findings`, returns 200
- MCP: `list_code_repository_findings`
- CLI: `oxagen steering findings`
- App: Repositories, the Instruction files section
- Authentication: org Owner or Admin, or workspace Owner, Member, or Viewer
- Billing: `noBillingGate: true`
- Agent: Stella finds it with `search_tools` and loads it with `load_tools`. It reads only, so it runs without approval.

## Input

None. The input is `{}`, and the call's scope names the workspace.

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `repositories[]` | `{ repository_id, provider, full_name, findings }` | A linked repository and its findings. `repository_id` is the workspace's binding of the repository (`rpb_…`). `provider` is `github` or `gitlab`. `full_name` is `owner/name` on the host |
| `repositories[].findings[]` | object | One flagged statement. The rows below name its fields as `findings[].<field>` |
| `findings[].id` | `string` | The finding's id (`crf_…`). [promote_instruction_to_steering](repository.instruction.promote.md) takes it |
| `findings[].path` | `string` | The instruction file, such as `AGENTS.md` |
| `findings[].line` | `int` | The line the statement starts on, at the commit the check read |
| `findings[].statement` | `string` | The statement's text |
| `findings[].kind` | `repeat` or `contradiction` | `repeat` when the statement says what the record says. `contradiction` when it says the opposite |
| `findings[].record` | `{ lineage, label, path }` | The steering record the statement matches. `lineage` is the name every version of the record shares. `label` can be null. `path` is where the record lives in the steering repo, or null |
| `findings[].pull_request` | `{ number, url, state, head_sha }` | The pull request that added the line. `state` is `open`, or `merged` once the line reached the default branch. `head_sha` is the commit the check read |
| `findings[].file_url` | `string` | The line on the host, at `head_sha` |
| `findings[].checked_at` | ISO 8601 time | When the check ran |
| `findings[].proposal` | `{ id, status }` or null | The proposal that promote_instruction_to_steering opened from this finding. `status` is a proposal status, such as `pr_open` or `merged` |

## Semantics

Every pull request in a linked repository gets the `Oxagen` check ([repository binding spec §3.5](../specs/repository-binding/README.md#35-code-repository-check)). The check reads the instruction files the pull request changes, such as `AGENTS.md`, `CLAUDE.md`, and the files in `.cursor/rules/`. It keeps the list items and paragraphs the pull request adds and compares each one with the workspace's active steering records. It stores the statements it flags: the repository, the pull request, the commit it read, the file, the line, and the text.

A repeat says what a record already says. A contradiction says the opposite: it forbids what the record requires, or requires what the record forbids.

The stored row does not say which record the statement matched. Each call compares every stored statement with the workspace's active records again, with the check's own test. A record revised or retired after the check ran changes the answer at once. A statement that matches no record now is left out. This comparison runs no model and reads nothing from GitHub or GitLab.

A row follows its pull request:

- Each new run of the check on an open pull request replaces that pull request's rows. A statement the new run finds again keeps its `id` and its `proposal`.
- A pull request closed without merging deletes its rows.
- A merged pull request keeps its rows, with `state` set to `merged`. The merge also reads each file it changed and deletes the merged rows whose statement that file no longer holds. So a later pull request that removes a line removes its finding when it merges.

The read lists linked repositories only. Unlinking a repository hides its findings.

## Limits

- A finding appears only after the check runs on a pull request. A repository linked before the check existed shows nothing until its next pull request.
- The read lists lines that pull requests add. A line that sat on the default branch before the repository was linked never appears.
- The check reads a bounded number of files and statements per pull request. §3.5 of the repository binding spec gives the limits.
