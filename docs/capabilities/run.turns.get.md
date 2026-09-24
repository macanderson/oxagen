# get_run_turns

The Run page's run waterfall (Mission Control spec §12.9; #4067): one run's per-turn ledger over every frame it recorded. Each row is one turn with its model and tool steps, its frames, its cost and the run's cost so far, and the input tokens its model calls reported. The Cost tab draws its per-turn bars, its cost-so-far line, the ledger table under them, and the Shape of the run and Cost so far instruments from these rows.

A wrapped run is counted in ClickHouse in two reads, whatever its length: one finds where each chain's turns open and where the proxy began observing it, and one groups every frame by chain and turn. A 250,000-frame run answers in about 0.3 seconds, where the Cost tab's former read of the whole transcript took 19 seconds and stopped at the transcript's 10,000-frame fold. A ledger run is read from the ledger and counted frame by frame.

**Surfaces:** api, mcp, cli

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs/turns`
- MCP: `get_run_turns`
- CLI: `oxagen run turns <run-id> [--json]`
- Authentication: session or API key (org Owner, Admin, Billing or Member; workspace Owner or Member)
- Capability name: `get_run_turns`
- Not billed (`noBillingGate: true`): a console read is never a governed action. IAM default-deny; medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `runId` | string | yes | `arun_…` or `tse_…` |

## Output

| Field | Type | Description |
|---|---|---|
| `runId` | string | as asked |
| `turns` | object[] | one per turn, in order; at most 10,000 |
| `complete` | boolean | false only when the run has more than 10,000 turns and `turns` holds the first of them |

Each turn:

| Field | Type | Description |
|---|---|---|
| `turn` | integer | 1-based, the number the transcript's entries carry for the same turn |
| `seq` | string | the frame the turn opens on, on the run's own chain |
| `at` | string | RFC 3339; when that frame was recorded |
| `frames` | integer | every frame recorded in the turn, on every chain |
| `modelSteps` | integer | the model calls made in the turn, each counted once however many sources reported it |
| `toolSteps` | integer | the tool calls made in the turn, one per call id on each chain |
| `cost` | object or null | `{ micros, currency, basis }`, the turn's cost records summed; null when none of its frames carried one |
| `cumulativeCost` | object or null | every cost record of the run through the end of the turn, including any recorded before the first turn; null before the first |
| `tokens` | object | `{ inputUncached, cacheRead }`, the input the turn's model calls reported; each is null when no call reported it |

## What a turn counts

- **Turns.** A recording with `turn_start` frames opens a turn at each one on the run's own chain, and the frames before the first are in no turn. A recording without them opens turn 1 at its first frame and a new turn wherever the recorded turn index changes. A subagent's own `turn_start` is the prompt its parent handed it, so it opens no turn of the run.
- **Subagents.** A subagent's chain counts toward the turn that spawned it: the `subagent_start` naming its spawning tool call, or else its agent id. A chain no spawn names counts toward the turn in progress when it began, and a chain spawned by another subagent counts toward its parent's turn. The chains are the ones Postgres lists under the root, the same list `get_run_transcript` reads.
- **Model calls.** A later sighting of a call (`oxagen.llm_call_duplicate_of`, which the host stamps on the second and later source to report one call, and on a transcript message's further content blocks) is not another call, carries no cost, and reports no tokens.
- **Late reports.** Once the proxy has observed one of a chain's model calls, the harness's own report of a later call on that chain carries no cost and reports no tokens. `get_run_transcript` applies the same rule.
- **Tool calls.** The gate, the request, the harness check, the result, and the copies an OTel log and a transcript add are one call when they carry one call id. Tool frames with no call id pair as request and result.

`cost` sums the same records the transcript's entries carry, so a turn's cost here equals the sum of its entries' `cost` there. `tokens` sums the same reported usage the transcript's entries carry.

## Honesty

A turn nothing priced answers `cost: null`, and a class no call reported answers null. Neither is a zero. A ledger run's frames carry no cost record, so its turns answer `cost: null`. A live run answers the turns recorded so far. An id outside the caller's workspace answers `not_found`.
