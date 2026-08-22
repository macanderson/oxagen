# eval.dataset.create

**Domain:** eval
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Create an eval dataset — a named, workspace-scoped collection of cases used to
score a target against. A dataset is created empty; items are added afterward,
either a batch at a time via `eval.dataset.item.add` or captured automatically
from real, already-metered production traces via `eval.dataset.from_traces`.
This is a definition-row write only — it spends no AI tokens and is not
billing-gated.

## Input

| Field         | Type      | Notes                                                              |
| ------------- | --------- | ------------------------------------------------------------------- |
| `name`        | `string`  | Dataset display name (min 1 char)                                  |
| `slug`        | `string?` | Lowercase kebab-case slug; derived from `name` when omitted        |
| `description` | `string?` | Optional free-text description                                     |

## Output

| Field      | Type     | Notes                                                                             |
| ---------- | -------- | ---------------------------------------------------------------------------------- |
| `datasetId`| `string` | Internal UUID of the eval dataset row                                            |
| `publicId` | `string` | Public id for the dataset — pass to `eval.dataset.get`, `eval.dataset.item.add`, `eval.dataset.from_traces` results, and `eval.run.start` |
| `slug`     | `string` | Resolved slug (generated from `name` when not supplied)                          |

## Side effects

New row in Postgres (eval datasets table), workspace-scoped. No AI tokens
spent — `noBillingGate`.

## Errors

None explicitly defined in the contract.
