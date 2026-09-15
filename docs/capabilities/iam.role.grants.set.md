# iam.role.grants.set

`set_role_grants`: replace a custom IAM role's grants with a permission set from the catalogue (ADR-057). Every grant the role carried is removed and one `allow` grant per capability the permissions name is written, in one transaction, so a holder's next authorization sees the new set and nothing in between. Built-in roles are read-only: duplicating one through `create_role` is the path to a custom one.

## Mode

**sync**

## Surfaces

- API: `POST /v1/:org/:ws/iam/roles/grants`
- MCP: `set_role_grants`
- Agent: callable (approval required, risk: high)

## Access

Org `Owner` or `Admin`, checked in the handler (INV-29). `noBillingGate`. Sensitivity **high**.

| code        | reason                               | when                                                                                                                                       |
| ----------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `forbidden` | `no_principal` / `org_role_required` | no signed-in user and no API key with a live creator, or an acting user (the signed-in user, or the key's creator) outside Owner and Admin |
| `forbidden` | `enterprise_tier_required`           | the org's tier is not enforced (see `create_role`)                                                                                         |
| `not_found` | `role_not_found`                     | no role with that public id in the org                                                                                                     |
| `conflict`  | `system_role_readonly`               | the role is system-seeded                                                                                                                  |
| `forbidden` | `delegation_ceiling_exceeded`        | a capability the new set names is above the granter's own; the old grants stay                                                             |

## Input

| Parameter     | Type     | Required | Description                                                            |
| ------------- | -------- | -------- | ---------------------------------------------------------------------- |
| `roleId`      | string   | yes      | public role id, `rol_…`                                                |
| `permissions` | string[] | yes      | the full set the role allows after the call; one or more catalogue ids |

## Output

`{ role: RoleRow }` with the new `permissions`, `grants` and the current `memberCount`.

## Side effects

- Postgres: `iam.role_grants` rows of the role replaced; `iam.roles.updated_at` and `updated_by_user_id` set; the deny-generation trigger bumps the org's counter.
- `security.security_events`: `iam.role_grants_set`.
