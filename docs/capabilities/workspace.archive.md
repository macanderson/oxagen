# workspace.archive

`archive_workspace`: archive a workspace (issue #2964). A workspace with a registered agent is refused: every `agent.agents` row in it that is not deleted, not `archived` and not the seeded `qa-chat` agent counts, and those agents are deregistered or moved first. Archiving records `workspace.workspaces.archived_at` and `archived_by_user_id` together. From then on the workspace leaves `list_workspaces` — the switcher and the CLI picker — unless the caller passes `includeArchived`; its runs, frames and records stay readable and its slug stays taken. A run admitted in an archived workspace is not refused by the kernel.

Machine credentials stop at the door. Under ADR-104 an API key bound to an archived workspace no longer authenticates on any surface: `resolveApiKey` refuses it with `workspace_archived`, which `apps/api` answers as 401 and `apps/mcp` carries as its own failure reason. No key row is written, so nothing is revoked and restoring the workspace restores the keys. `suspendedApiKeys` in the output reports how many live keys the call took out of service — keys that are soft-deleted or already expired are dead already and are not counted. Keys stranded by an archival that happened before ADR-104 are covered by the same check, with no migration; an operator who wants one gone for good reaches it through the `/{org}/api-keys` workspace picker, which keeps archived workspaces in the list.

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
| `conflict`  | `workspace_has_agents`               | a registered agent is in the workspace; the message carries how many                                                                       |

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
| `suspendedApiKeys` | number | live API keys in the workspace that stop authenticating while it is archived; none is revoked |

## Side effects

- Postgres: `archived_at`, `archived_by_user_id`, `updated_at`, `updated_by_id` on the workspace row. Nothing else is written; `auth.api_keys` is read, never changed.
- `security.security_events`: `workspace.archived`.
- Every API key bound to the workspace stops resolving until the workspace is restored (ADR-104).
