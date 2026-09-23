# list_sso_providers

**Domain:** org
**Mode:** sync
**Scope:** organisation (`scoped: false`, requires an orgId, no workspace)
**Surfaces:** api, mcp
**Sensitivity:** high · **Default effect:** deny · **Roles:** org Owner, Admin
**Billing gate:** none · **Agent tool:** no (the in-app agent never reads or changes how people sign in)
**Plan:** any. `entitled` says whether the plan includes SSO.

Contract: `packages/oxagen/src/contracts/org.sso.list.ts`
Handler: `packages/handlers/src/org.sso.list.ts`
API: `GET /v1/:org/:workspace/org/sso`
MCP: `apps/mcp/src/tools/org.sso.list.ts`
Decision record: [ADR-145](../adr/ADR-145-enterprise-sso-behind-better-auth.md)

## Intent

Show an org admin every SSO identity provider the organisation has
registered, what to configure in each identity provider, and whether SSO is
required.

The list reads on every plan, so an organisation that left the Enterprise
plan can still see its providers and delete them.

## Input

None. The providers are the caller's organisation's.

## Output

| Field | Notes |
| --- | --- |
| providers | One view per provider, oldest first |
| policy.ssoRequired | Whether members other than Owners must sign in through SSO |
| entitled | Whether the organisation's plan includes SSO. Only the Enterprise plan does |

Each provider view carries `providerId`, `displayName`, `protocol` (`oidc` or
`saml`), `domain`, `domainVerified`, `issuer`, `groupsClaim`, and:

- `domainVerification`: the TXT record to publish, as `recordName`
  (`_oxagen-sso.<domain>`) and `recordValue`
  (`oxagen-sso-verification=<token>`).
- `callbackUrl`: the redirect URI (OIDC) or ACS URL (SAML) to enter in the
  identity provider. It is `BETTER_AUTH_URL` plus the plugin's callback path.
- `spMetadataUrl`: SAML only, the SP metadata URL the identity provider can
  import. It is also the SP entity id.
- `oidc`: `clientId`, `clientSecretSet`, and `scopes`. `null` for SAML.
- `saml`: `entryPoint` and `spPrivateKeySet`. `null` for OIDC.
- `groupRoles`: the provider's group-to-role table.

No secret is returned. The stored config passes through `redactSsoConfig`,
which turns each secret into `true` before anything reads it.

## Side effects

None. The read is not audited: it changes nothing.
