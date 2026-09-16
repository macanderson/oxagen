# iam.role.create

`create_role`: a custom IAM role from the permission catalogue (ADR-063). One `allow` grant is written to `iam.role_grants` per capability the chosen permissions name, in the same transaction as the `iam.roles` row. Custom roles are agent roles: only `assign_agent_role` binds them; the seven membership roles stay the seeded system set.

## Mode

**sync**

## Surfaces

- API: `POST /v1/:org/:ws/iam/roles` (201)
- MCP: `create_role`
- Agent: callable (approval required, risk: high)

## Access

Org `Owner` or `Admin`, checked in the handler (`assertOrgRole`, INV-29) for the signed-in user or, on an API-key (MCP) call, the key's creator (`resolveActingUserId`). `noBillingGate` (a settings write, ADR-052 exclusion 2). Sensitivity **high**.

No tier gates this write (ADR-067, superseding ADR-063 decision 3). `list_iam_roles.enforcement` reports whether the kernel's IAM check runs the resolver for the org, and the Roles page prints that either way. The delegation ceiling reads no tier, so a granter is held to what they hold on every plan.

The handler refuses, in this order:

| code        | reason                               | when                                                                                                                                                                |
| ----------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forbidden` | `no_principal` / `org_role_required` | no signed-in user and no API key with a live creator, or an acting user (the signed-in user, or the key's creator) outside Owner and Admin                          |
| `forbidden` | `delegation_ceiling_exceeded`        | a capability the permissions name resolves to less than `allow` for the granter (the message names them); the system org Owner passes by resolver rule 7.5          |
| `conflict`  | `role_exists`                        | the name is already used in the same scope kind (`roles_org_scope_name_uq`), or by another custom role of the org in either scope kind (`roles_org_custom_name_uq`) |

## Input

| Parameter     | Type                   | Required | Description                                                                                          |
| ------------- | ---------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `name`        | string                 | yes      | 2–64 chars, lower-case letters and digits with single `.` `-` `_` separators; immutable once created |
| `scopeKind`   | `"org" \| "workspace"` | yes      | org-wide, or assigned in one workspace at a time                                                     |
| `description` | string \| null         | no       | up to 500 chars; default `null`                                                                      |
| `permissions` | string[]               | yes      | one or more catalogue permission ids (`list_iam_roles.catalog`)                                      |

## Output

`{ role: RoleRow }` — the row `list_iam_roles` reports, with `memberCount: 0`, `permissions` equal to the input set and `createdBy` the caller's name.

## Side effects

- Postgres: one `iam.roles` row (`is_system_default = false`), one `iam.role_grants` row per capability with `effect = 'allow'`; the deny-generation trigger on `role_grants` bumps the org's counter.
- `security.security_events`: `iam.role_created`.
