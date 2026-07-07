# graph.node.label.remove

**Domain:** graph
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** agent
**Risk level:** low

## Intent

Remove one or more labels from a node, multi-label-agnostic. Removing a label the node does not have is a no-op. Never touches the node's other labels or its properties — the complement of `graph.node.label.add` (e.g. drop a `:Billing` domain label without disturbing `:Payment`). Labels are validated by `LABEL_PATTERN` (Cypher-injection guard) only; no registry membership check.

## Input

| Field | Type | Notes |
|---|---|---|
| `nodeId` | `string` | publicId of the target node. |
| `labels` | `string[]` | Labels to remove (each validated by `LABEL_PATTERN`); at least one. |

## Output

| Field | Type | Notes |
|---|---|---|
| `nodeId` | `string` | The target node's publicId. |
| `labels` | `string[]` | The node's full label set after the remove. |
| `removed` | `string[]` | Labels that were present and got removed. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- Neo4j: removes labels from the target node.

## Errors

| code | meaning |
|---|---|
| `validation_error` | A label failed `LABEL_PATTERN`, or `labels` was empty. |
| `not_found` | No node matches `nodeId` in this workspace. |
| `unauthorized` | Caller lacks the required org/workspace role. |
