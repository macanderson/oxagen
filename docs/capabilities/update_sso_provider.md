# update_sso_provider

**Domain:** org
**Mode:** sync
**Scope:** organisation (`scoped: false`, requires an orgId, no workspace)
**Surfaces:** api, mcp
**Sensitivity:** high · **Default effect:** deny · **Roles:** org Owner, Admin
**Billing gate:** none · **Agent tool:** no
**Plan:** Enterprise. On any other plan the call is refused.

Contract: `packages/oxagen/src/contracts/org.sso.update.ts`
Handler: `packages/handlers/src/org.sso.update.ts`
API: `PATCH /v1/:org/:workspace/org/sso/providers/:providerId`
MCP: `apps/mcp/src/tools/org.sso.update.ts`
Decision record: [ADR-145](../adr/ADR-145-enterprise-sso-behind-better-auth.md)

## Intent

Change a provider's display name, groups claim, or protocol settings without
deleting it.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| providerId | slug | The provider to change |
| displayName | string? | Omit to keep |
| groupsClaim | string? | Omit to keep |
| config | OIDC or SAML settings? | Same shape as `create_sso_provider`. `clientSecret` and `spPrivateKey` are optional here |

A secret left out keeps the sealed value already stored. The stored config is
never decrypted to do this.

The domain cannot change, because verification binds the provider to it. To
move a provider to another domain, delete it and create a new one. The
protocol cannot change either.

## Output

`{ provider }`, the view `list_sso_providers` returns.

## Side effects

1. A new OIDC issuer runs discovery again, with the same checks as
   `create_sso_provider`. An unchanged issuer keeps the stored endpoints.
2. A new groups claim is written to the row and to
   `mapping.extraFields.groups` in the stored config.
3. Secrets are sealed and checked as on create. `AUTH_TOKEN_ENCRYPTION_KEY`
   is needed only when `config` is sent.
4. **Audit** an `sso.provider_updated` event with `changedFields`
   (`displayName`, `groupsClaim`, `config`). A call that changes nothing
   writes nothing and emits nothing.

## Errors

- `forbidden` / `sso_requires_enterprise`: the organisation is not on the
  Enterprise plan. The role check runs first.
- `not_found` / `sso_provider_not_found`: no such provider in this
  organisation.
- `invalid_input`: a protocol that does not match the provider's, an OIDC
  update with no secret sent or stored, or a discovery failure.
