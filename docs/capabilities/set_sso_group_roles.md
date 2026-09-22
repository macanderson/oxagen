# set_sso_group_roles

**Domain:** org
**Mode:** sync
**Scope:** organisation (`scoped: false`, requires an orgId, no workspace)
**Surfaces:** api, mcp
**Sensitivity:** high · **Default effect:** deny · **Roles:** org Owner, Admin
**Billing gate:** none · **Agent tool:** no
**Plan:** Enterprise. On any other plan the call is refused.

Contract: `packages/oxagen/src/contracts/org.sso.group_roles.set.ts`
Handler: `packages/handlers/src/org.sso.group_roles.set.ts`
API: `PUT /v1/:org/:workspace/org/sso/providers/:providerId/group-roles`
MCP: `apps/mcp/src/tools/org.sso.group_roles.set.ts`
Decision record: [ADR-142](../adr/ADR-142-enterprise-sso-behind-better-auth.md)

## Intent

Decide which organisation role each identity-provider group grants. At
sign-in, the highest-ranked role any of a person's groups maps to wins
(`admin`, then `compliance`, then `billing`, then `member`). A person whose
groups map to nothing is granted nothing. `owner` cannot be mapped:
ownership is transferred by a person, never minted by an identity provider.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| providerId | slug | The provider the table belongs to |
| mappings | `{ group, role }[]`, up to 200 | The whole table. `group` is case-sensitive and appears once. `role` is `admin`, `compliance`, `billing` or `member` |

## Output

`{ providerId, mappings }`, the table as stored.

## Side effects

1. Replace the provider's `org.sso_group_roles` rows in one transaction:
   the old rows are deleted and the new ones inserted. An empty list clears
   the table.
2. **Audit** an `sso.group_roles_set` event carrying the table after the
   write.

## Errors

- `forbidden` / `sso_requires_enterprise`: the organisation is not on the
  Enterprise plan. The role check runs first.
- `not_found` / `sso_provider_not_found`: no such provider in this
  organisation.
- `invalid_input`: more than 200 rows, a group mapped twice, or a role
  outside the four.
