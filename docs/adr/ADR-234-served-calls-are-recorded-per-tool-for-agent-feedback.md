# ADR-234: Served calls are recorded per tool for agent feedback

- **Status:** Accepted
- **Date:** 2026-09-30
- **Owners:** mcp-studio
- **Related:** issue #4678, `apps/mcp/src/servers/call.ts`,
  `apps/mcp/src/servers/meter.ts`,
  `packages/telemetry/src/served-tool-calls.ts`,
  `packages/telemetry/src/migrations/0037_served_tool_calls.sql`.

## Context

MCP Studio's tool panel shows agent feedback (mcp-studio-spec, Feedback).
The spec names two signals. A reflection's `tool_feedback` names a tool and
the problem an agent had with it. The gateway counts schema rejections,
error results, and retries per tool.

The first signal is stored. `agent.memory_reflections.tool_feedback` holds
`{ tool, problem }` entries, with each tool named `<server>__<tool>`.

The second is not. The served tools meter every call as a governed action,
but the ledger entry keeps no outcome. The call path collapses every
failure into `outcome: "failed"`, so a schema rejection and a missing
credential look the same. `record-read.ts` sets `feedback: null` for every
tool, and the panel shows the not-recorded state.

## Decision

The served tools write one row per call to a tool into a new ClickHouse
table, `served_tool_calls` (migration 0037). The write sits beside the
meter, through a `ServedPorts.recordCall` port. Like the meter, a failed
write is logged and the call's answer stands.

A row holds the server's name, the full tool name, the tacho session's
`tse_` id, the metered outcome, and a `problem`:

- `schema_rejected` when the tool's input schema refused the arguments, when
  Cedar could not read them, or when a search-mode `call` passed arguments
  that are not an object.
- `error_result` when the tool ran and answered with an error result.
- Empty for every other outcome, such as a denial by policy, a parked call,
  a missing credential, or a route that refused the call. Those say nothing
  about the tool.

A call to a search-mode `call` that names no tool, or a tool the server does
not have, writes no row. Search and describe write none.

`readServedToolFeedback` answers, per tool of one server over a window:

- **Calls.** Rows whose outcome is `allowed` or `failed`, plus any row with a
  problem. A policy denial or a parked call never reached the tool.
- **Schema rejections** and **error results.** Rows with that problem.
- **Retries.** A call to a tool in a run after an earlier call to the same
  tool in that run had a problem. A row with no run is never a retry.

The Studio read looks back 30 days, as `list_tool_versions` does for
`calls30d`. The table keeps rows 180 days, as `tool_invocations` does.

The tool name is the join key. Compile names a tool `<folder>__<key>`, and
the manifest's server name is the folder's name, so the gateway's row, the
reflection's entry, and the Studio record's tool all use one string.

## Alternatives

**Add columns to `tool_invocations`.** That table is shaped for the in-app
agent. Its `message_id` is a required UUID, `external_server_id` is a UUID,
and `packages/telemetry/README.md` forbids a made-up key in
`execution_step_id`. A served call has no message, names its server by the
folder name, and belongs to a string run id. Each served row would carry a
fake key.

**Derive the counts from the governed-action ledger.** The ledger keeps no
outcome and no argument check, and it is a billing record. Adding feedback
columns to it would mix a billing key with telemetry.

**Count retries in the gateway.** The gateway handles each request alone and
keeps no state between calls, so it cannot know a call is a retry. The read
computes retries from the run's rows in time order.

## Consequences

- The Studio read (#4678, part 4B) reads these counts and the reflections'
  notes. A tool shows counts only from the day this ships. Older calls were
  never recorded.
- The retry count needs a run. A request that names no tacho session writes
  an empty run, and its calls are counted but never as retries.
- `chSelect` admits one single-table SELECT, so the read runs two queries:
  totals per tool, and per run only for runs that had a problem.
