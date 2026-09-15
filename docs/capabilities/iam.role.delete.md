# iam.role.delete

`delete_role`: remove a custom IAM role nobody holds (ADR-057). The role row and its grants go; the kernel's `capability.invoke_*` audit rows and the `iam.role_*` security events keep the record of what it granted and when. A role is never deleted out from under a holder.

## Mode

**sync**

## Surfaces

- API: `POST /v1/:org/:ws/iam/roles/delete`
- MCP: `delete_role`
- Agent: callable (approval required, risk: high)

## Access

Org `Owner` or `Admin`, checked in the handler (INV-29). `noBillingGate`. Sensitivity **high**. No tier gate: removing a role narrows nothing.

| code        | reason                               | when                                                                                                                                       |
| ----------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `forbidden` | `no_principal` / `org_role_required` | no signed-in user and no API key with a live creator, or an acting user (the signed-in user, or the key's creator) outside Owner and Admin |
| `not_found` | `role_not_found`                     | no role with that public id in the org                                                                                                     |
| `conflict`  | `system_role_readonly`               | the role is system-seeded                                                                                                                  |
| `conflict`  | `role_in_use`                        | an active (non-deleted, unexpired) assignment holds it; the message carries the count                                                      |

## Input

| Parameter | Type   | Required | Description             |
| --------- | ------ | -------- | ----------------------- |
| `roleId`  | string | yes      | public role id, `rol_…` |

## Output

| Field  | Type   | Description                  |
| ------ | ------ | ---------------------------- |
| `id`   | string | the deleted role's public id |
| `name` | string | its name                     |

## Side effects

- Postgres: the role's `iam.role_grants` rows and its `iam.roles` row deleted.
- `security.security_events`: `iam.role_deleted`.
