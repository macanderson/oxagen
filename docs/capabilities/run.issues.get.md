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

## Sources

Three records name an issue, and nothing else does (ADR-197):

- **The task.** The run's task reference. `owner/repo#N` or a GitHub issue URL names a GitHub issue. Any other reference, such as `ENG-4121`, is a tracker key Oxagen does not read, and its row says `not_github`.
- **Closing references.** The issues GitHub records as closed by each pull request the run recorded opening: a wrapped run's `oxagen:pr_link` frames, and a ledger run's `provider_publish.pull_request_opened` events. Only the closing list is read. A pull request matched by branch or head commit adds nothing, because it does not show the run opened it.
- **Frames.** A wrapped run's command and GitHub MCP frames. The server parses each command head for `gh issue <verb> <N|URL>`, `gh api repos/o/r/issues/N`, and literal `github.com/o/r/issues/N` URLs. It also reads the `issue.repository`, `issue.number`, `issue.url` and `issue.action` attrs the recorder writes on a GitHub MCP issue tool's frame and on `gh issue create`'s frame. `echo gh issue view 3`, a here-document body and `gh issue list` name nothing. A ledger run records no command, so it lists its task and closing references only.

One row stands for each issue. A task that a frame or a closing reference also names keeps `relation: "task"` and `edge: "stated"` and carries those frames. A closing issue a frame also names stays `resolves`.

A bare `#N` takes its repository from the command's `-R`, `--repo` or `GH_REPO`, then from the one repository recorded for the checkout the frame ran in, then from the run's only recorded repository. Otherwise the row reads `ref: "#N"`, `repository: null` and `statusRead: "repository_unknown"`.

## Tracker reads and the cache

A closing reference carries GitHub's title and state with the closing list. Every other issue in a GitHub repository is read on load through the workspace's connection for that repository, one GraphQL call per repository. A run reads at most 50 issues per load. Past that, a row reads `read_limit` and the answer carries `tracker_read_limit`.

Each state GitHub gives is cached in the serving process for 60 seconds, keyed by organization, workspace, repository and number. A load inside that minute answers from the cache and reads GitHub for nothing. `readAt` is when GitHub answered, so a cached row says how old its state is. A failed read is not cached.

A number GitHub resolves to a pull request is not an issue. Its row is dropped with `pull_request_ref_skipped`, except the task's, which stays with `statusRead: "not_found"`.

`complete` is false only when an issue may be missing from the list: a closing list that was not read or was cut short, a receipt in a repository with no connection, the 2,000-frame or ledger event limit, more than 200 issues (`issue_frame_limit`), or a chain break. A state that was not read, or a skipped pull request number, leaves the list whole.

## Honesty

An issue's state is the forge's, read on load, and a state the read could not take stays null with the reason beside it. A reader renders "status unknown" for it, never a guessed state. No link is inferred from a branch name or from model output, so an issue the run never named and no pull request closes is not on the list.
