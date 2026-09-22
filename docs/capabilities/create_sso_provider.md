# create_sso_provider

**Domain:** org
**Mode:** sync
**Scope:** organisation (`scoped: false`, requires an orgId, no workspace)
**Surfaces:** api, mcp
**Sensitivity:** high · **Default effect:** deny · **Roles:** org Owner, Admin
**Billing gate:** none · **Agent tool:** no (the in-app agent never reconfigures sign-in)
**Plan:** Enterprise. On any other plan the call is refused.

Contract: `packages/oxagen/src/contracts/org.sso.create.ts`
Handler: `packages/handlers/src/org.sso.create.ts`
API: `POST /v1/:org/:workspace/org/sso/providers`
MCP: `apps/mcp/src/tools/org.sso.create.ts`
Decision record: [ADR-142](../adr/ADR-142-enterprise-sso-behind-better-auth.md)

## Intent

Register an OIDC or SAML identity provider for one email domain. The
provider signs nobody in until `verify_sso_domain` finds the DNS TXT record
its view names.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| providerId | slug, 2 to 63 chars | Appears in the callback URL. Unique across Oxagen |
| displayName | string, 1 to 120 chars | The sign-in button's label |
| domain | email domain | Lowercased. One domain has one provider across Oxagen |
| groupsClaim | string? | The claim or attribute carrying groups. Defaults to `groups` |
| config | OIDC or SAML settings | See below |

OIDC `config`: `protocol: "oidc"`, `issuer` (https), `clientId`,
`clientSecret`, and optional extra `scopes`. `openid`, `email` and `profile`
are always requested.

SAML `config`: `protocol: "saml"`, `issuer` (the IdP entity id), `entryPoint`
(the IdP SSO URL, https), `cert` (the IdP signing certificate, PEM), and an
optional `spPrivateKey` (PEM) to sign AuthnRequests.

## Output

`{ provider }`, the view `list_sso_providers` returns, with
`domainVerified: false` and an empty `groupRoles`.

## Side effects

1. **Refuse without a KMS.** When `AUTH_TOKEN_ENCRYPTION_KEY` is unset the
   call fails before any network read or write. No secret is stored in
   plaintext.
2. **OIDC discovery.** The handler reads
   `<issuer>/.well-known/openid-configuration` with a 10-second timeout and
   no redirects. The document's `issuer` must match the one entered,
   ignoring a trailing slash, and it must name `authorization_endpoint`,
   `token_endpoint` and `jwks_uri`. The issuer and every endpoint must be
   public https URLs. The endpoints are stored, so sign-in never runs
   discovery. The token endpoint uses `client_secret_basic` unless the
   provider lists only other methods, then `client_secret_post`.
3. **Seal.** The plugin config is built from an allowlist, including
   `mapping.extraFields.groups`, which carries the groups claim to the
   sign-in provisioner. The client secret and the SP private key are sealed
   with the KMS envelope. The write is refused if any secret is left in
   plaintext.
4. **Insert** the `auth.sso_providers` row, unverified, with a fresh
   48-character verification token.
5. **Audit** an `sso.provider_created` security event naming the provider,
   protocol and domain.

## Errors

- `forbidden` / `sso_requires_enterprise`: the organisation is not on the
  Enterprise plan. The role check runs first.
- `AUTH_TOKEN_ENCRYPTION_KEY` unset: refused rather than stored in plaintext.
- `invalid_input`: a malformed field, an issuer on a private address, a
  discovery document that cannot be read, names another issuer, lacks an
  endpoint, or names an endpoint on a private address.
- `conflict` / `provider_id_taken`: another provider uses this id.
- `conflict` / `domain_taken`: another provider, in any organisation, uses
  this domain.
