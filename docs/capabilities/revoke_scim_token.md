# revoke_scim_token

**Domain:** org
**Mode:** sync
**Scope:** organisation (`scoped: false`, requires an orgId, no workspace)
**Surfaces:** api, mcp
**Sensitivity:** high · **Default effect:** deny · **Roles:** org Owner, Admin
**Billing gate:** none · **Agent tool:** no
**Plan:** any. An organisation that left the Enterprise plan can still turn SCIM off.

Contract: `packages/oxagen/src/contracts/org.scim_token.revoke.ts`
Handler: `packages/handlers/src/org.scim_token.revoke.ts`
API: `DELETE /v1/:org/:workspace/org/sso/scim-token`
MCP: `apps/mcp/src/tools/org.scim_token.revoke.ts`
Decision record: [ADR-145](../adr/ADR-145-enterprise-sso-behind-better-auth.md)

## Intent

Stop the identity provider pushing to Oxagen (#3734). The live token stops
working at once. People already provisioned keep their memberships and roles.

## Input

None.

## Output

`{ revoked }`. `false` when no token was live, in which case nothing changed.

## Side effects

1. Set `revoked_at` on the live `org.scim_tokens` row.
2. **Audit** a `scim.token_revoked` event naming its prefix. No row is
   written when nothing was revoked.
