# read_steering

**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** mcp
**Risk level:** low

## Intent

An agent reads one steering record that its index or [search_steering](steering.search.md) named, or one file from a skill's folder. A record comes back as the model reads it: a heading with its label, then the body with its `@tool:` mentions rendered for each tool's exposure mode. The frontmatter never comes back. The workspace's record wins over an organization record of the same lineage.

The steering repo spec proposed the name `steering_read`. ADR-025 puts the verb first.

## Input

| Field | Type | Notes |
|---|---|---|
| `lineage` | lineage | The record or skill to read, such as `a-intel.domain.refund`. |
| `file?` | `string` (1–512) | A file in the skill's folder, such as `words.md`. Unset, the record itself. |

## Output

| Field | Type | Notes |
|---|---|---|
| `lineage` | `string` | The lineage read. |
| `label` | `string` | The record's label. |
| `kind` | `string` | The record's kind. |
| `source` | `"workspace"` or `"organization"` | The version the record came from. |
| `version` | `int` | That version's number. |
| `path` | `string` | The file's path in the steering repo. |
| `text` | `string` | The record as the model reads it, or the skill file's text. |

## Refusals

| Code | Reason | When |
|---|---|---|
| `not_found` | `steering_record_not_found` | Neither published version holds the lineage. Find it with `search_steering`. |
| `not_found` | `steering_file_not_found` | The skill's folder holds no file by that name. |
| `not_found` | `steering_run_versions_unrecorded` | The call names a run. Oxagen does not yet record which versions a run received. |

## Versions

A call reads the versions published now. The MCP surface carries no run id (`packages/handlers/src/steering.published.ts`).

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member, Workspace Viewer.

## Side effects

None. Not billed (`noBillingGate: true`).
