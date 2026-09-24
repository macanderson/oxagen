# list_runs

The runs table on the Fleet page (`apps/app/ARCHITECTURE.md` §1.2). One list over the two stores that record runs: the evidence ledger (`agent.agent_runs`, public id `arun_…`) for runs an external engine submits evidence for, and `tacho.sessions` (public id `tse_…`) for wrapped agents. Root sessions only; a subagent chain is part of its parent's run. Newest first, keyset-paged on an opaque cursor. An API-key caller is shown no witness run (a run a `proof.observed` verdict names as its `witness_run_id`, ADR-064): a worker holds API keys and never sees a witness.

The in-app agent's turns are excluded. Each turn is a run of its own (MC spec §14.1), admitted on the `chat` or `api-chat` surface by `openAssistantRun` (`@oxagen/agent`), and the assistant is Oxagen's: the customer talks to it and never owns or manages it, so its runs never appear in the customer's list (Mockups `71bc546`; `apps/app/ARCHITECTURE.md` §1.2). `get_run` still opens one by its id, which is how the flyout's per-turn run link works; `list_recent_runs` reads through this same exclusion.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs`
- MCP: `list_runs`
- Authentication: session (org Owner, Admin, or Member; workspace Owner or Member)
- Capability name: `list_runs`
- Not billed (`noBillingGate: true`): a console read is never a governed action (ADR-052 exclusion 2), so a page load stays off the GAU meter and reachable at `remaining = 0`. IAM default-deny; medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `limit` | integer | no | 1-100, default 50 |
| `cursor` | string | no | the `nextCursor` of an earlier page; a cursor this capability did not write is `invalid_input` |

## Output

| Field | Type | Description |
|---|---|---|
| `runs` | object[] | see the row below |
| `nextCursor` | string or null | null on the last page |

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
| `cost` | object or null | `{ micros, currency, basis }` from the run's `cost.run_totals` row (ADR-060); `basis` is `gateway_observed`, `client_attested`, `mixed` or `estimated`; null until the rollup has priced the run's frames after its seal |
| `model` | `{ id, provider, tier }` or null | the model the run ended on, falling back to the one it started on (`tacho.sessions.model_final`, then `model_initial`). `provider` is the vendor the id names and `tier` the capability class inside that vendor's family (`haiku`, `sonnet`, `opus`; `mini`, `nano`; `flash`, `pro`), not a billing tier and not Oxagen's white-labelled fast/balanced/precise. Either is null when the id names none this platform recognises. Null for every ledger run, which records no model on its row |
| `machine` | `{ hostname, platform, osVersion, arch, nodeVersion }` or null | the enrolled host the run ran on (`tacho.hosts`). `hostname` and `platform` are required of an enrolment and the rest may be null. Null for a ledger run, which names no host |
| `taskRef` | string or null | the goal a ledger run was admitted for. Null for a wrapped session, since no dispatch record names its task. `get_run_work` reads the issues its pull requests close |
| `startedAt` | string | RFC 3339 |
| `sealedAt` | string or null | when the server recorded the seal, so it trails the stop by the host's shipping delay. Null while live |
| `endedAt` | string or null | when the run stopped, by the recorder's clock: the stop event's timestamp for a wrapped session, the seal for a ledger run. Null while live. A wall clock ends here |
| `replayGrade` | `inspect` \| `view` \| `fork` \| `retry` or null | the grade the seal recorded (spec §8.4), null while live, on a seal the recorder never graded, or on a broken row; never computed on read, and a caller renders the recorded word and nothing stronger |
| `verdict` | enum or null | the run's witness verdict as its `cost.run_totals` row recorded it (spec §8.5, §12.8; ADR-064): `flipped`, `failing`, `unmoved`, `unsatisfied`, `tampered`, `unverified` or `waived`; null when no witness reported on the run or the rollup has not rebuilt it. Only `flipped` marks a run proven |
| `name` | string or null | the generated name (`summarize_run`), null until written |
| `summary` | `{ text, generatedAt, model }` or null | the generated summary with the model that wrote it and the instant; labelled generated wherever it renders |

## Honesty

A null is what a caller renders as "not recorded". The operator's name is read through the principal's `parent_user_id` and only where the principal's kind is `human`, because a delegated agent principal carries the `parent_user_id` of whoever created it and naming that person would put a name on a run they did not start. `iam.principals.display_name` is deliberately not the source: provisioning falls that column back to the user's email address, and a run row carries a name or nothing. The provider on `model` is the one `providerFromModelId` gives every metered call, so a run page and the meter never disagree about who served the same call. Cost comes from the run's `cost.run_totals` row, which the rollup job rebuilds from the run's frames after its seal; a run with no row yet, or a row whose frames priced nothing, answers `cost: null`, never `0`, and nothing here reads ClickHouse or the tacho session's own `total_cost_micros`. Every query names `org_id` and `workspace_id` in addition to RLS, so a run from another workspace stays out of the list on a stack that runs with the RLS bypass on.
