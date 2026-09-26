# get_run_outputs

What one run produced, in the order it produced it (macanderson/oxagen#3609). This is the Run page's spine: it sits between the run header and the tabs, not behind one of them, because the first question anyone brings to a run is what came of it.

One node per thing the run produced. A node carries a kind, a name, where it landed, the disposition the store recorded, a one-line note, a diff stat where the recorder counted lines, and the frame sequence the `fr N` chip opens. A path the run only read comes back as a `read` node, so the surface can draw it as a mark and never as a change.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs/outputs`
- MCP: none. This is a console read of one run's record, and MCP is the surface agents connect to.
- Authentication: a signed-in session (org Owner, Admin or Member; workspace Owner or Member).
- Capability name: `get_run_outputs`
- Not billed (`noBillingGate: true`): a console read is never a governed action. IAM default-deny; medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `runId` | string | yes | `arun_…` or `tse_…` |

## Output

| Field | Type | Description |
|---|---|---|
| `runId` | string | as asked |
| `source` | enum | `wrapped` (a `tse_…` session) or `ledger` (an `arun_…` run). The node shapes differ by store, so the reader says which one answered |
| `nodes` | object[] | the spine: frame nodes in frame order, then the gates that stopped the run |
| `tally` | object | `{ artifacts, reads, gates }`, the header's count |
| `complete` | boolean | false when the read stopped at a cap, so the spine is a prefix |

### A node

| Field | Type | Description |
|---|---|---|
| `seq` | string or null | the frame that produced it, decimal. Null on a gate and its `would`: the approval record carries no frame sequence, and a position is never invented |
| `kind` | enum | `file`, `media`, `change`, `commit`, `pr`, `gate`, `would`, `read` |
| `name` | string | a repository-relative path, a commit sha, `#482`, the capability a gate parked, or, on a ledger change, the `rpl_` path locator |
| `nameIsLocator` | boolean | true when `name` is an opaque locator and not a path. Read it before rendering the name as a file name |
| `where` | string or null | a repository id on a commit or a pull request, the language on a file, `oxagen` on a gate |
| `state` | enum | `created`, `written`, `deleted`, `renamed`, `pushed`, `open`, `read`, `awaiting`, `blocked`, `withheld` |
| `note` | string or null | one line from the record |
| `stat` | object or null | `{ added, removed }`, the lines the recorder counted. Null on every node it counted none for, including every read |
| `observedAt` | string or null | RFC 3339 |
| `digestBefore`, `digestAfter` | string or null | sha256 before and after, where the record carries them |

`tally.artifacts` counts `file`, `media`, `change`, `commit` and `pr`. A read, a gate and a withheld `would` are not things the run produced, so none of them is an artifact.

## Errors

| Code | Reason | When |
|---|---|---|
| `not_found` | `run_not_found` | no run with that id in this workspace |
| `forbidden` | `org_role_required` | a user outside the org's members |

## Reading a wrapped session

A `tse_…` run reads `tacho.session_files`: one row per path the session touched, with its read, write, edit and delete counters, its diff stat, git's word for what happened to it, and the first and last frame that touched it.

A row is a `read` node when its writes, edits and deletes are all zero, and a durable node otherwise. A read never carries a diff stat, however many lines its row counted: a path the run only looked at changed nothing.

The state is git's `observed_status` where a reconciliation recorded one, because that word states a condition. Where it recorded none, the state comes from the counters. It is never a word git did not say.

Each `oxagen:pr_link` frame the harness sealed adds a pull request node. The node names the PR number, sits in the repository the frame's `pr.repository` attribute names, and carries the frame's `pr.url` as its note. A frame sealed before #3944 carries the same facts as `pr_number`, `pr_repository`, and `pr_url`, and the read accepts either spelling. Two frames with the same URL make one node, at the first frame's sequence.

## Reading a ledger run

An `arun_…` run reads its `change.recorded` and `provider_publish.*` receipts.

A ledger change cannot name a file. The receipt carries `path_locator_public_id`, an opaque `rpl_` locator, and the path is deliberately never part of the event. Nothing in the database resolves the locator back to a path.

The node names the locator and sets `nameIsLocator: true`, which tells the surface to say the ledger recorded the change without its path rather than render `rpl_…` where a reader expects a file name. Dropping the node instead would make a run that changed eleven files read as a run that changed nothing. A receipt that carries no locator at all is skipped, never given an invented name.

Commit and pull-request receipts keep their own nodes: a commit names its sha and its tree digest, a pull request names its number and its head commit.

## Where a gate sits

A governed gate is a parked or refused call on this run (`agent.approval_requests.run_public_id`). The row carries no frame sequence, so a gate node carries `seq: null` and sits after every frame node. That is where it stopped the run: nothing after it happened.

Each gate is followed by a `would` node naming the capability that has not run. An approved gate draws nothing, because the call went through and whatever it produced has a node of its own.

## Caps

One read returns at most 500 nodes, walks at most 10,000 ledger events, and reads at most 50 approval rows. Any cut sets `complete: false`, and the surface says the spine ends early rather than presenting a prefix as the whole run.

## Honesty

Every badge carries the value the store recorded and nothing stronger. A run that produced nothing answers an empty spine and a zero tally, which the page states as a fact about the run. Media thumbnails are out of scope here; #3608 owns them.
