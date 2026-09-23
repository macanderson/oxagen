# delete_sso_provider

**Domain:** org
**Mode:** sync
**Scope:** organisation (`scoped: false`, requires an orgId, no workspace)
**Surfaces:** api, mcp
**Sensitivity:** high · **Default effect:** deny · **Roles:** org Owner, Admin
**Billing gate:** none · **Agent tool:** no
**Plan:** any, so an organisation that left the Enterprise plan can still remove a provider.

Contract: `packages/oxagen/src/contracts/org.sso.delete.ts`
Handler: `packages/handlers/src/org.sso.delete.ts`
API: `DELETE /v1/:org/:workspace/org/sso/providers/:providerId`
MCP: `apps/mcp/src/tools/org.sso.delete.ts`
Decision record: [ADR-144](../adr/ADR-144-enterprise-sso-behind-better-auth.md)

## Intent

Remove an identity provider and its group-to-role table.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| providerId | slug | The provider to delete |

## Output

`{ deleted: true }`.

## Side effects

1. Delete the `auth.sso_providers` row. Its `org.sso_group_roles` rows go
   with it (`ON DELETE CASCADE`).
2. When SSO is required and no provider with a verified domain remains, set
   `sso_required` to false in the same transaction and audit an
   `sso.policy_updated` event. Otherwise every member but the Owners would be
   locked out.
3. **Audit** an `sso.provider_deleted` event naming the provider, protocol
   and domain.

## Errors

- `not_found` / `sso_provider_not_found`: no such provider in this
  organisation, including a second delete of the same one.
