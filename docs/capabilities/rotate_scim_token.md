# rotate_scim_token

**Domain:** org
**Mode:** sync
**Scope:** organisation (`scoped: false`, requires an orgId, no workspace)
**Surfaces:** api
**Sensitivity:** high · **Default effect:** deny · **Roles:** org Owner, Admin
**Billing gate:** none · **Agent tool:** no
**Plan:** Enterprise.

Contract: `packages/oxagen/src/contracts/org.scim_token.rotate.ts`
Handler: `packages/handlers/src/org.scim_token.rotate.ts`
API: `POST /v1/:org/:workspace/org/sso/scim-token/rotate`
Decision record: [ADR-145](../adr/ADR-145-enterprise-sso-behind-better-auth.md)

## Intent

Replace the organisation's SCIM token (#3734). One transaction revokes the
live token and mints its replacement, so the old token stops working when the
call returns. With no live token it mints one, which recovers a token nobody
wrote down.

## Input

None.

## Output

The same shape as `create_scim_token`: `{ token, baseUrl, view }`.

## Side effects

1. Set `revoked_at` on the live `org.scim_tokens` row and insert the new row.
2. **Audit** a `scim.token_rotated` event naming the new prefix.

## Errors

- `forbidden` / `sso_requires_enterprise`: the organisation is not on the
  Enterprise plan.
