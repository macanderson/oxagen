# agent.subagent.dispatch

**Domain:** agent
**Mode:** async
**Scope:** tenant + workspace
**Surfaces:** agent
**Risk level:** medium

## Intent

Spawn N subagents in parallel via Inngest fanout. Each subagent runs a
single scoped capability against its slice of the parent task and
returns its result for parent aggregation. The dispatch returns
immediately with a fanout handle; the parent uses
`agent.subagent.aggregate` to collect the completed results.

## Input

| Field             | Type                                   | Notes                                                  |
| ----------------- | -------------------------------------- | ------------------------------------------------------ |
| `parentMessageId` | `string`                               | Chat message that owns the fanout for audit and UI.    |
| `fanout`          | `Array<{ capability, input, label? }>` | 1 to 16 entries. Each runs as an independent subagent. |

## Output

| Field             | Type       | Notes                                                          |
| ----------------- | ---------- | -------------------------------------------------------------- |
| `fanoutId`        | `string`   | Handle used by `agent.subagent.aggregate`.                     |
| `childMessageIds` | `string[]` | One child-message id per fanout entry, in input order.         |

## Side effects

- Inngest: send N `agent.subagent.invoked` events; each event spawns one Inngest run.
- ClickHouse: emit a `agent.fanout.dispatched` row in `execution_events`.
- Postgres: insert N rows in `execution.chat_messages` as child messages of the parent.

## Errors

| code              | meaning                                          |
| ----------------- | ------------------------------------------------ |
| `fanout_too_wide` | More than 16 entries; split across turns.        |
| `unknown_capability` | A fanout entry references a non-existent capability. |

## SPEC references

- §3 — subagent dispatch
- §4 — new capabilities
