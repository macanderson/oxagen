# get_run_issues

The Run page's Issues tab (#3970): the issues one run worked on, each with its state as the forge reads it now, whether that read happened, what the run did to the issue, and the frames that show it.

**Surfaces:** api, mcp

**Mode:** sync

**Input:** `{ runId: "tse_…" | "arun_…" }`

**API:** `POST /v1/:org_slug/:workspace_slug/runs/issues`

**MCP:** `get_run_issues`

No CLI command reads it. The CLI's run commands cover export, chain and turns.

This console read does not consume AI credits (`noBillingGate: true`). IAM is default-deny with medium sensitivity, and the roles are `get_run_work`'s: organization Owner or Admin, workspace Owner or Member.

## Output

| Field | Type | Description |
|---|---|---|
| `runId` | string | as asked |
| `issues` | object[] | at most 200; the run's task first, then by the first frame that names each issue |
| `complete` | boolean | false when a read limit cut the list; `warnings` names which |
| `warnings` | string[] | `closing_issue_limit`, `closing_issues_read_failed`, `recorded_repository_not_connected`, `issue_frame_limit`, `tracker_read_limit`, `pull_request_ref_skipped`, `chain_break` or `ledger_event_limit` |

Each issue:

| Field | Type | Description |
|---|---|---|
| `ref` | string | `owner/repo#N`, `#N` when the repository is not resolved, or a tracker key as recorded |
| `repository` | object or null | `{ host, owner, name, url, connected }`, as `get_run_work` names a repository; null when the record does not resolve it |
| `number` | integer or null | null for a tracker key that carries no number |
| `title` | string or null | the title the forge records; null when it was not read |
| `status` | enum or null | `open`, `closed`, `in_progress` or `blocked`; null unless `statusRead` is `read` |
| `statusRead` | enum | `read`, or why the state was not read: `no_connection`, `not_github`, `repository_unknown`, `not_found`, `read_failed` or `read_limit` |
| `readAt` | string or null | RFC 3339; when `status` was read |
| `relation` | enum | `task` for the issue the run was admitted for, `resolves` for an issue a pull request the run opened closes on merge, `referenced` for an issue a frame names |
| `resolvedBy` | object[] | `{ number, url }` for each of the run's pull requests that closes the issue, at most 20; empty unless `relation` is `resolves` |
| `actions` | enum[] | what the frames show the run doing to the issue: `viewed`, `commented`, `created`, `edited`, `closed`, `reopened` or `mentioned` |
| `edge` | enum | `stated` for the run's task, `observed` when a frame shows the link |
| `frameSeqs` | string[] | the frames that name the issue, seqs ascending, at most 20 |
| `url` | string or null | the issue's page on the forge; null when the record names none |

## Honesty

An issue's state is the forge's, read on load, and a state the read could not take stays null with the reason beside it. A reader renders "status unknown" for it, never a guessed state. No link is inferred from a branch name or from model output, so an issue the run never named and no pull request closes is not on the list.
