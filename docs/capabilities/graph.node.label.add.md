# graph.node.label.add

**Domain:** graph
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** agent
**Risk level:** low

## Intent

Add one or more labels to an existing node. Multi-label-agnostic: it does not care how many labels the node already carries, has no "primary label" concept, and never overwrites or removes existing labels. Idempotent — re-adding a label the node already has is a no-op (e.g. tag `:Billing` onto a node that is already `:Payment`, yielding `:Billing:Payment`). Labels are validated by `LABEL_PATTERN` (Cypher-injection guard) only; there is intentionally no registry / active-vocabulary membership check.

## Input

| Field | Type | Notes |
|---|---|---|
| `nodeId` | `string` | publicId of the target node. |
| `labels` | `string[]` | Labels to add (each validated by `LABEL_PATTERN`); at least one, e.g. `['Billing']` or `['Billing','Pii']`. |

## Output

| Field | Type | Notes |
|---|---|---|
| `nodeId` | `string` | The target node's publicId. |
| `labels` | `string[]` | The node's full label set after the add. |
| `added` | `string[]` | Labels that were not already present. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- Neo4j: adds labels to the target node.

## Errors

| code | meaning |
|---|---|
| `validation_error` | A label failed `LABEL_PATTERN`, or `labels` was empty. |
| `not_found` | No node matches `nodeId` in this workspace. |
| `unauthorized` | Caller lacks the required org/workspace role. |
