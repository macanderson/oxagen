# workspace.archive

`archive_workspace`: freeze a workspace (issue #2964). Archiving records `workspace.workspaces.archived_at` and `archived_by_user_id` together. From then on the workspace leaves `list_workspaces` — the switcher and the CLI picker — unless the caller passes `includeArchived`; its runs, frames and records stay readable and its slug stays taken. Nothing else changes in this revision: a run admitted in an archived workspace is not refused by the kernel.

## Mode

**sync**

## Surfaces

- API: `POST /v1/:org/:ws/workspaces/archive`
- MCP: `archive_workspace`
- Agent: callable (approval required, risk: high)

## Access

Org `Owner` or `Admin`, checked in the handler (INV-29). `noBillingGate` (a settings write). Sensitivity **high**.

| code        | reason                               | when                                                                                                                                       |
| ----------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `forbidden` | `no_principal` / `org_role_required` | no signed-in user and no API key with a live creator, or an acting user (the signed-in user, or the key's creator) outside Owner and Admin |
| `not_found` | `workspace_not_found`                | no workspace with that public id in the org                                                                                                |
| `conflict`  | `already_archived`                   | archived before; the message carries when                                                                                                  |

## Input

| Parameter     | Type   | Required | Description                  |
| ------------- | ------ | -------- | ---------------------------- |
| `workspaceId` | string | yes      | public workspace id, `wrk_…` |

## Output

| Field        | Type   | Description         |
| ------------ | ------ | ------------------- |
| `id`         | string | public workspace id |
| `slug`       | string |                     |
| `name`       | string |                     |
| `archivedAt` | string | ISO-8601            |

## Side effects

- Postgres: `archived_at`, `archived_by_user_id`, `updated_at`, `updated_by_user_id` on the workspace row.
- `security.security_events`: `workspace.archived`.
