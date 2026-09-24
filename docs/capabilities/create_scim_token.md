# create_scim_token

**Domain:** org
**Mode:** sync
**Scope:** organisation (`scoped: false`, requires an orgId, no workspace)
**Surfaces:** api
**Sensitivity:** high · **Default effect:** deny · **Roles:** org Owner, Admin
**Billing gate:** none · **Agent tool:** no
**Plan:** Enterprise.

Contract: `packages/oxagen/src/contracts/org.scim_token.create.ts`
Handler: `packages/handlers/src/org.scim_token.create.ts`
API: `POST /v1/:org/:workspace/org/sso/scim-token`
Decision record: [ADR-145](../adr/ADR-145-enterprise-sso-behind-better-auth.md)

## Intent

Mint the bearer token your identity provider uses to push users and groups to
`/api/scim/v2` (#3734). The answer carries the token once. Oxagen stores only
its SHA-256, so a lost token is replaced with `rotate_scim_token`, never read
back. Not on MCP: a token in a tool result lands in an agent's transcript.

## Input

None.

## Output

`{ token, baseUrl, view: { tokenPrefix, createdAt, lastUsedAt } }`. `baseUrl`
is the SCIM endpoint to enter in the identity provider.

## Side effects

1. Insert an `org.scim_tokens` row with the token's prefix and hash.
2. **Audit** a `scim.token_created` event naming the prefix.

## Errors

- `forbidden` / `sso_requires_enterprise`: the organisation is not on the
  Enterprise plan. The role check runs first.
- `conflict` / `scim_token_exists`: a live token exists. Rotate it instead.
