# list_runs

The runs table on the Fleet page (`apps/app/ARCHITECTURE.md` §1.2). One list over the two stores that record runs: the evidence ledger (`agent.agent_runs`, public id `arun_…`) for runs an external engine submits evidence for, and `tacho.sessions` (public id `tse_…`) for wrapped agents. Root sessions only; a subagent chain is part of its parent's run. Newest first, keyset-paged on an opaque cursor. An API-key caller is shown no witness run (a run a `proof.observed` verdict names as its `witness_run_id`, ADR-064): a worker holds API keys and never sees a witness.

The in-app agent's turns are excluded. Each turn is a run of its own (MC spec §14.1), admitted on the `chat` or `api-chat` surface by `openAssistantRun` (`@oxagen/agent`), and the assistant is Oxagen's: the customer talks to it and never owns or manages it, so its runs never appear in the customer's list (Mockups `71bc546`; `apps/app/ARCHITECTURE.md` §1.2). `get_run` still opens one by its id, which is how the flyout's per-turn run link works; `list_recent_runs` reads through this same exclusion.

The status, tier and replay-grade filters, the search, the order and the offset run on the server across both stores, so they reach every run in the workspace and not only the newest page (#3837). A call that sends none of them lists exactly as before: newest first, one keyset page per store, merged. A call that sends any of them reads the run index (`packages/handlers/src/run.list.index.ts`), one `UNION ALL` over both stores that filters, searches and orders in SQL, then reads the page's rows through the same selects and mappers the keyset page uses.

## Mode

**sync**

## Surface

**Surfaces:** api, mcp, agent, cli

- API: `POST /v1/:org_slug/:workspace_slug/runs`
- MCP: `list_runs`
- CLI: `oxagen run list [--limit <n>] [--cursor <cursor>] [--json]` prints each run's id, agent, status, tier, cost, and start. It prints the cursor for the next page when the page stopped before the oldest run.
- Agent: one of the in-app assistant's seven pins, offered on every turn (`INTERACTIVE_AGENT_CAPABILITIES`). Low risk, no approval.
- Authentication: session (org Owner, Admin, or Member; workspace Owner or Member)
- Capability name: `list_runs`
- Not billed (`noBillingGate: true`): a console read is never a governed action (ADR-052 exclusion 2), so a page load stays off the GAU meter and reachable at `remaining = 0`. IAM default-deny; medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `limit` | integer | no | 1-100, default 50 |
| `cursor` | string | no | the `nextCursor` of an earlier page; a cursor this capability did not write is `invalid_input` |
| `pullRequests` | `any`, `with` or `without` | no | absent or `any` lists every run. `with` lists wrapped sessions whose frames name a pull request or whose `pr_open` calls ingest counted. `without` lists wrapped sessions with neither. Both leave out ledger runs, whose receipts name a repository id and no page. A filtered page reads at most five batches of 100 sessions, so it may hold fewer than `limit` runs and still carry a `nextCursor`, which continues after the last session it read |
| `status` | array of `live`, `sealed`, `halted` | no | 1 to 3 values; only runs in these statuses. A ledger `pending` or `running` run is `live`, `completed` or `failed` is `sealed`, and `cancelled` is `halted`. A session's `running` is `live`, `aborted` is `halted`, and every other outcome is `sealed`. Paused and compacted runs keep their status (ADR-190) |
| `tier` | array of `contained`, `gateway`, `harness`, `observe` | no | 1 to 4 values; only runs published at these tiers. A ledger run's tier is its latest seal's, and a ledger run with no graded seal reads `harness` |
| `replayGrade` | array of `inspect`, `view`, `fork`, `retry`, `not_recorded` | no | 1 to 5 values. `not_recorded` matches a run whose `replayGrade` is null, which includes every live run |
| `query` | string | no | 1 to 200 characters after trimming. A case-insensitive substring matched against the public id, the name, the harness title, the agent key, the operator's name, the model id, the hostname, and a ledger run's goal. `%` and `_` match themselves |
| `sort` | `{ key, dir }` | no | `key` is `started`, `agent`, `operator`, `status`, `tier`, `replay` or `cost`; `dir` is `asc` or `desc`. Absent means `started` descending. A run with no value for the key sorts last in both directions, and ties fall back to newest first. `status` sorts `live`, `sealed`, `halted`. `tier` and `replay` sort along their ladders, not alphabetically. `cost` sorts by the priced figure in micro-units, falling back to what a wrapped session reported, across currencies. Frames, name, pull requests, lines and tokens cannot be sorted |
| `offset` | integer | no | 0 to 10,000; rows to skip in the filtered, sorted list. Page N of size L is `offset = (N - 1) * L` |

These inputs refuse each other as `invalid_input`, with the code as the message:

- `cursor_with_offset`: `cursor` and `offset` together. A cursor already says where the page starts.
- `cursor_with_sort`: `cursor` with any `sort` but `started` descending. A cursor is a position in the newest-first order.
- `pull_requests_with_offset` and `pull_requests_with_sort`: a `pullRequests` filter of `with` or `without` with an `offset` above 0 or another order. The pull requests are read from the frames a page at a time, so that filter pages newest first by cursor.

`nextCursor` is set only in the newest-first order. In any other order a caller pages by `offset` and reads the page count from `total`.

## Output

| Field | Type | Description |
|---|---|---|
| `runs` | object[] | see the row below |
| `nextCursor` | string or null | null on the last page |
| `warnings` | array of `pull_requests_unread`, optional | the pull-request frames could not be read. Rows carry no `pullRequests`, and a filtered page decided on the counted `pr_open` calls alone |
| `total` | integer or null, optional | the runs that match every filter and the search across both stores, whatever the page. Null when more than `totalBound` match. Absent when the read did not count: under a `pullRequests` filter of `with` or `without`, which only the frames in ClickHouse answer, or when the count failed |
| `totalBound` | integer, optional | 10,000 (`RUN_LIST_TOTAL_BOUND`), present whenever `total` is. A caller shows `10,000+` when `total` is null |

Each row:

| Field | Type | Description |
|---|---|---|
| `id` | string | `arun_…` or `tse_…` |
| `source` | enum | `ledger`, `tacho` — Halt and frames depend on it |
| `agentKey` | string or null | `org_ns.ws_ns.slug`; null when the ledger row names no agent |
| `operatorId` | string or null | the initiating principal's public id; null when none was recorded |
| `operatorKind` | `human` \| `agent` \| `service` or null | what the initiating principal is; null when none was recorded, or when the row's kind is outside the column's CHECK |
| `operatorName` | string or null | the person's name, from `auth.users.display_name` for the user the principal acts for. Null for every principal that is not a person, and null for a person whose user record carries no name; `operatorKind` separates the two. Never an email address, and never a name derived from one |
| `operatorAttribution` | `initiator`, `host_enroller` or null | how the record came to name the operator. `initiator` is the principal a ledger run was admitted for. `host_enroller` is the person who enrolled the machine a wrapped session ran on, which a page labels "enrolled by", because a wrapped session carries no principal Oxagen can map to an org member. Null when no operator was recorded |
| `status` | enum | `live`, `sealed`, `halted` |
| `outcome` | enum | how the run ended, in the word its own store recorded: `running`, `completed`, `failed`, `cancelled`, `crashed`, `unknown`. Required on every row, and never derived. `status` is the lifecycle, and three words cannot tell a run that finished from one that failed, so the outcome travels beside it. A ledger `pending` reads `running`, because that is the only thing an open run can be said to be doing. A wrapped session's `aborted` reads `cancelled`, the reading `status` already gives it. `crashed` is a harness that died mid-run. `unknown` is a session that stopped reporting before it recorded an end, and it stays `unknown`: a run that may have finished is not a run that finished |
| `turns` | integer or null | null for a ledger run whose model-call payloads are encrypted |
| `steps` | integer | model calls plus tool calls |
| `frames` | integer | recorded events (ledger) or hash-chained events (tacho) |
| `cost` | object or null | `{ micros, currency, basis }` from the run's `cost.run_totals` row (ADR-060); `basis` is `gateway_observed`, `client_attested`, `mixed` or `estimated`; null until a rollup has priced any of the run's frames. The row is rebuilt while the run records frames and again at its seal (ADR-159) |
| `costIsEstimate` | boolean, optional | true while `cost` is a running estimate: the run is open, or its row was rebuilt before the seal. False once the sealed run is rolled up, and false with no cost |
| `model` | `{ id, provider, tier }` or null | the model the run ended on, falling back to the one it started on (`tacho.sessions.model_final`, then `model_initial`). `provider` is the vendor the id names and `tier` the capability class inside that vendor's family (`haiku`, `sonnet`, `opus`; `mini`, `nano`; `flash`, `pro`), not a billing tier and not Oxagen's white-labelled fast/balanced/precise. Either is null when the id names none this platform recognises. Null for every ledger run, which records no model on its row |
| `commandBlock` | `run_sealed` \| `no_host` \| `host_revoked` \| `host_offline` or null | why an operator command cannot reach the run, or null when it can (ADR-163). The enforcement tier plays no part: an observe-tier run whose host polled in the last five minutes takes pause, resume, cancel and steer. `host_offline` is a host that has not polled for commands in that window. Null for a ledger run, which the ledger path controls. Absent when the host's status was not read |
| `machine` | `{ hostname, platform, osVersion, arch, nodeVersion }` or null | the enrolled host the run ran on (`tacho.hosts`). `hostname` and `platform` are required of an enrolment and the rest may be null. Null for a ledger run, which names no host |
| `taskRef` | string or null | the goal a ledger run was admitted for. Null for a wrapped session, since no dispatch record names its task. `get_run_work` reads the issues its pull requests close |
| `startedAt` | string | RFC 3339 |
| `sealedAt` | string or null | when the server recorded the seal, so it trails the stop by the host's shipping delay. Null while live |
| `sealSource` | `agent_stop` \| `idle_timeout` \| `operator` or null, optional | what sealed a wrapped session: its host's own `agent_stop`, which the host's next `agent_start` on the same chain reopens (a resume, ADR-172); the control plane closing a run that sent no event for 12 hours (`tacho.session-idle-close`, ADR-159), which the run's next event reopens; or `operator`, a person sealing the run through [`seal_run`](run.seal.md) (ADR-169), which no later frame or `agent_stop` reopens or replaces. A seal recorded before the column existed reads `agent_stop`. Null while live, and for a ledger run |
| `endedAt` | string or null | when the run stopped, by the recorder's clock: the stop event's timestamp for a wrapped session, the last event recorded for one the control plane closed for silence, the seal for a ledger run. Null while live. A wall clock ends here |
| `replayGrade` | `inspect` \| `view` \| `fork` \| `retry` or null | the grade the seal recorded (spec §8.4), null while live, on a seal the recorder never graded, or on a broken row; never computed on read, and a caller renders the recorded word and nothing stronger |
| `verdict` | enum or null | the run's witness verdict as its `cost.run_totals` row recorded it (spec §8.5, §12.8; ADR-064): `flipped`, `failing`, `unmoved`, `unsatisfied`, `tampered`, `unverified` or `waived`; null when no witness reported on the run or the rollup has not rebuilt it. Only `flipped` marks a run proven |
| `name` | string or null | the generated name (`summarize_run`), null until written |
| `summary` | `{ text, generatedAt, model }` or null | the generated summary with the model that wrote it and the instant; labelled generated wherever it renders |
| `pullRequests` | array of `{ url, number, repository, state }`, optional | the pull requests (or GitLab merge requests) a wrapped session's chain-verified frames name, earliest first, at most 10: `oxagen:pr_link` frames, and `pr_open` calls whose output printed a URL (ClickHouse `tacho_events`). `url` is as recorded, and a caller links it only when it names a page it recognises. `state` is `open`, `draft`, `merged`, `closed` or null. It is null today, because no store records a pull request's state. [`get_run_work`](run.work.get.md) reads the live state from GitHub for one run. Absent for a ledger run, and absent when the frames could not be read |
| `pullRequestsOpened` | integer, optional | the `pr_open` calls ingest counted for a wrapped session (`tacho.sessions.pull_requests`), including calls whose output named no URL. Absent for a ledger run |
| `diff` | `{ added, removed, basis }` or null, optional | lines added and removed. `harness_reported` is the session's own total (`tacho.sessions.lines_added` and `lines_removed`), which the harness reports when the session ends. While that is absent, `git_observed` is the uncommitted change git reported at the last worktree check, summed over the root and subagent chains (`tacho.session_files` rows with an observed status). Committed work leaves git's figure, so it is a floor. Null when neither reported a change, never `+0 -0` |

## Honesty

A null is what a caller renders as "not recorded". The operator's name is read through the principal's `parent_user_id` and only where the principal's kind is `human`, because a delegated agent principal carries the `parent_user_id` of whoever created it and naming that person would put a name on a run they did not start. `iam.principals.display_name` is deliberately not the source: provisioning falls that column back to the user's email address, and a run row carries a name or nothing. The provider on `model` is the one `providerFromModelId` gives every metered call, so a run page and the meter never disagree about who served the same call. Cost comes from the run's `cost.run_totals` row, which the rollup jobs rebuild from the run's frames while it runs and again after its seal; a run with no row yet, or a row whose frames priced nothing, answers `cost: null`, never `0`, and the row never reads the tacho session's own `total_cost_micros` as its cost. The `cost` sort does fall back to it, as `reportedCost`, because that is the figure the Fleet row shows for a run with no rollup yet. The one ClickHouse read is the pull requests a page's wrapped sessions name. When it fails, the rows stay up without them and the page says `pull_requests_unread`. The total is a bounded count: each store counts at most 10,001 matching rows, so a large workspace costs no more to count than one at the bound, and a sum past the bound reads null rather than a number the count did not reach. Every query names `org_id` and `workspace_id` in addition to RLS, so a run from another workspace stays out of the list on a stack that runs with the RLS bypass on.
