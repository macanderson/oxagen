# agent.memory.list

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Enumerate the ACTIVE `:AgentMemory` nodes a workspace has accumulated, newest
first, with optional class / kind / enforcement / node filters. The non-semantic
**browse** counterpart to `agent.memory.recall`. Both read the same `:AgentMemory`
nodes, so every surface sees an identical memory set with no store drift.

## Input

| Field            | Type                                | Notes                                                  |
| ---------------- | ----------------------------------- | ------------------------------------------------------ |
| `nodeRef`        | `string?`                           | Scope to memories anchored on a single graph node ref. |
| `memoryClass`    | `"OBSERVATION" \| "RULE" \| "FACT"`? | Filter to a single epistemic class.                   |
| `memoryKind`     | `string?`                           | Filter to a single content-domain kind.                |
| `minEnforcement` | `int 1–100`?                        | Only return rules at or above this enforcement.        |
| `limit`          | `number` (1 – 200)                  | Page size. Defaults to 100.                            |
| `offset`         | `number` (>= 0)                     | Page offset. Defaults to 0.                            |

## Output

| Field      | Type | Notes |
| ---------- | ---- | ----- |
| `memories` | `Array<AgentMemoryRecord>` | The page, newest first (full two-axis record). |
| `total`    | `number` | Total matching memories, ignoring `limit`/`offset`. |

## Side effects

None — read-only. Does not reinforce or decay.

## SPEC references

- `docs/specs/two-axis-memory/DESIGN.md`
