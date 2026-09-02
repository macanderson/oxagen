# graph.node.labels.get

**Domain:** graph
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** agent
**Risk level:** low

## Intent

Read a node's full label set. Read-only companion to `graph.node.label.add` / `graph.node.label.remove` — useful for verifying multi-label state and for a curator agent to inspect which domains a node belongs to.

## Input

| Field | Type | Notes |
|---|---|---|
| `nodeId` | `string` | publicId of the target node. |

## Output

| Field | Type | Notes |
|---|---|---|
| `nodeId` | `string` | The target node's publicId. |
| `labels` | `string[]` | The node's full label set. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member, Workspace Viewer.

## Side effects

None (read-only). Reads the node's labels from Neo4j.

## Errors

| code | meaning |
|---|---|
| `not_found` | No node matches `nodeId` in this workspace. |
| `unauthorized` | Caller lacks the required org/workspace role. |

## Related
- [The ontology read set](_ontology-read-set.md) — the graph reads an agent is granted together, and the `toolPolicy.ontology` opt-in
