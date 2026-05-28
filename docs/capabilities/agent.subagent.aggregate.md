# agent.subagent.aggregate

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** agent
**Risk level:** low

## Intent

Collect the completed results of a previously-dispatched fanout so the
parent message can synthesize a final answer. By default the call waits
for completion up to the timeout; passing `waitForCompletion: false`
returns whatever results have arrived so far.

## Input

| Field               | Type      | Notes                                              |
| ------------------- | --------- | -------------------------------------------------- |
| `fanoutId`          | `string`  | Handle returned by `agent.subagent.dispatch`.      |
| `waitForCompletion` | `boolean` | Defaults to `true`.                                |
| `timeoutMs`         | `number`  | Max wait in ms. Defaults to 120000; cap 300000.    |

## Output

| Field      | Type                                            | Notes                                       |
| ---------- | ----------------------------------------------- | ------------------------------------------- |
| `fanoutId` | `string`                                        | Echoes the input handle.                    |
| `status`   | `"pending" \| "completed" \| "partial" \| "timed_out"` | Aggregate status across all children. |
| `results`  | `Array<{ childMessageId, capability, status, output, error }>` | One entry per child message. |

## Side effects

- Postgres: read-only against `execution.chat_messages` and `execution.tool_calls` rows for the fanout.

## Errors

| code              | meaning                                          |
| ----------------- | ------------------------------------------------ |
| `unknown_fanout`  | The `fanoutId` does not exist in this workspace. |

## SPEC references

- §3 — subagent aggregation
- §4 — new capabilities
