# ADR-145: Enterprise SSO behind Better Auth

Status: Accepted

Date: 2026-09-22

Related: ADR-006, ADR-042, ADR-101, `packages/auth/src/sso/`,
`packages/auth/src/auth.ts`, `packages/database/src/sso-secrets.ts`,
`packages/oxagen/src/contracts/org.sso.shared.ts`,
`packages/handlers/src/lib/sso.ts`, `apps/app/src/server/sso-gate.ts`,
`packages/database/atlas/migrations/20260922220000_enterprise_sso.sql`,
`docs/guides/sso.md`

## Context

The security and engineering teams Oxagen sells to sign their people in
through an identity provider (IdP): Okta, Microsoft Entra ID, Google Workspace.
They expect three things from any tool that holds authority over their agents.
A person reaches it only through the IdP. The IdP's groups decide the person's
role. Removing someone from the IdP removes their access.

Before this change Oxagen had email and password, Google and GitHub sign-in,
and TOTP two-factor, all on Better Auth 1.6.11 (ADR-006). The docs said SSO
was not available, and `oxagen-roadmap:docs/oxagen/mission-control/GAP-INVENTORY.md` listed it as
cut.

Better Auth ships `@better-auth/sso` at the same version. It handles OIDC and
SAML 2.0 sign-in, links an existing account, and calls a `provisionUser` hook
after it verifies an assertion. Its provider-management endpoints assume
Better Auth's organization plugin, which Oxagen does not use. Oxagen keeps
organizations, membership, and roles in its own `org` and `iam` schemas and
changes them only through the capability kernel.

## Decision

### The plugin signs people in, and Oxagen owns everything around it

Sign-in runs through `@better-auth/sso` 1.6.11 over OIDC and SAML 2.0. OIDC
state, PKCE, SAML signature checks, and account linking are protocol work the
plugin already does and tests. Oxagen does not reimplement them.

**Rejected: a custom OIDC and SAML implementation.** It would own XML signature
validation and replay rules, and it would drift from the session and account
model Better Auth already keeps.

### Oxagen capabilities own provider CRUD

`create_sso_provider`, `update_sso_provider`, `delete_sso_provider`,
`list_sso_providers`, `verify_sso_domain`, `set_sso_policy`, and
`set_sso_group_roles` manage providers, domains, the require-SSO switch, and
the group mapping. Each one admits org Owner and Admin, runs through
`invoke()`, and writes an `sso.*` security event.

The plugin's own `/sso/register`, `/sso/providers`, `/sso/get-provider`,
`/sso/update-provider`, `/sso/delete-provider`,
`/sso/request-domain-verification`, and `/sso/verify-domain` endpoints are in
Better Auth's `disabledPaths`, and `providersLimit` is 0. Those endpoints
authorize against the organization plugin Oxagen does not run, so they would
either refuse everyone or admit the wrong people. They would also skip the
kernel's IAM check, the secret sealing below, and the audit event. The
capabilities write `auth.sso_providers` directly, and the adapter wrapper
refuses every provider write that reaches it through Better Auth, so a later
plugin write path cannot store a plaintext secret.

**Rejected: install the organization plugin to satisfy the endpoints.** It
would create a second membership model beside `org.org_users` and IAM, and the
two would disagree.

### Secrets are sealed in place and opened on read

The plugin stores a provider's OIDC and SAML settings as JSON text in
`auth.sso_providers.oidc_config` and `saml_config`, and parses that text on
every sign-in. It has no decrypt hook. The capabilities therefore seal each
secret inside the JSON before they write it. That covers the OIDC client
secret, SAML private keys, and their passphrases. Each becomes an
`enc:v1:<keyId>:<envelope>` token: AES-256-GCM under a fresh data key wrapped
by the master key in `AUTH_TOKEN_ENCRYPTION_KEY`, the same envelope model
credentials and plugin credentials use. `withSsoSecrets` wraps the Better Auth
adapter and opens the tokens when the plugin reads a row.

The issuer, endpoints, client ID, and IdP certificate stay readable, because
someone debugging a sign-in needs them and none of them is secret. A read
capability returns only whether each secret is set. A write refuses to store a
provider when the encryption key is not configured.

A secret that arrives already shaped like a token (`enc:…`) is refused, by the
contract and again by the handler. The sealer keeps a sealed value as it is and
the sign-in path opens it, so accepting one would let an admin make the server
decrypt a secret sealed for another organization and send it to an endpoint
that admin controls. Binding each token to its provider with AAD is the durable
fix, and #3740 carries it.

**Rejected: encrypt the whole config column.** The plugin reads the column
directly, so a whole-column cipher needs the same adapter wrapper and hides
the non-secret fields an operator needs.

**Rejected: a separate secrets table joined at read time.** The plugin reads
one row, so a join lives in the same wrapper with a second query per sign-in
and a second place to keep consistent.

### OIDC discovery runs once, at registration

`create_sso_provider` and `update_sso_provider` read the issuer's discovery
document and store the endpoints it names. The read refuses a non-https URL, a
redirect, and a URL whose host is a private, loopback, or link-local address,
and gives up after 10 seconds. Sign-in then uses the stored endpoints,
so the plugin's runtime discovery never runs. An admin cannot point the server at an internal address by typing one, and a
sign-in never waits on a discovery fetch.

### Domain verification is required

A provider signs nobody in until its organization publishes the TXT record
`_oxagen-sso.<domain>` with the value `oxagen-sso-verification=<token>` and
`verify_sso_domain` finds it. One organization holds one email domain, enforced
by a unique index. Verification is what stops an organization claiming a
domain it does not control. It is also what the plugin treats as a trusted
provider for linking, so a person who already has a password account links it
on their first SSO sign-in rather than being refused.

Verification alone does not stop an IdP asserting an address outside the
domain. The plugin's just-in-time path creates a user for whatever email the
IdP sends, and checks the domain only to decide whether linking is trusted. A
guard on Better Auth's `user.create` and `account.create` hooks
(`packages/auth/src/sso/domain-guard.ts`) therefore refuses both writes on
every SSO callback unless the email is in the provider's verified domain or a
subdomain of it. Without it, an organization running its own IdP could create
a user row for someone else's address, and the real owner's later Google
sign-in would link into that row.

### The mapping replaces the organization role on every sign-in

`org.sso_group_roles` maps an IdP group name, exact and case-sensitive, to one
of `admin`, `compliance`, `billing`, or `member` for one provider. The plugin
runs the provisioner on every sign-in (`provisionUserOnEveryLogin`). The
provisioner takes the highest-ranked role the person's groups map to, in the
order admin, compliance, billing, member, and makes it their organization
role. When no group maps, it removes their role and membership. An unmapped
group grants nothing.

The mapping is authoritative. Removing someone from an IdP group takes effect
at their next sign-in. A role an admin set by hand for an SSO member lasts only
until that sign-in.

Owner is not mappable, and the provisioner never changes an Owner. Ownership
passes by a transfer inside Oxagen. An IdP misconfiguration therefore cannot
demote the last Owner or mint a new one.

**Rejected: the mapping only adds roles.** Nothing would ever take a role away,
so leaving an IdP group would change nothing in Oxagen.

**Rejected: map on first sign-in only.** The same failure, deferred by one
sign-in.

### Require SSO is enforced at sign-in and at the organization gate

`security.org_security_policy.sso_required` needs at least one verified
provider. When it is on, a password sign-in for an email on the provider's
domain is refused in a Better Auth `before` hook, and a Google or GitHub
sign-in is ended in an `after` hook with a redirect to `/login?sso=required`.

A session created before the switch, or through another path, is caught at the
organization gate. `auth.sessions.auth_method` records how each session was
established (`sso:<providerId>`, `password`, `social:<provider>`, or `other`),
set on the server and never by a client. The app's gate admits a non-Owner
member of a require-SSO organization only with a session that one of that
organization's providers created.

Owners are exempt in both places. They are the break-glass account: an IdP
outage or a broken certificate must not lock every administrator out of the
switch that would fix it.

### Provisioning fails closed

When the provisioner cannot read the mapping or apply the role, it records
`sso.sign_in` with outcome `error` and throws. The plugin then sets no session
cookie. A person is never signed in with a role the mapping did not decide.

### SSO is an Enterprise feature

The maintainer decided on 2026-09-22 that SSO is part of the Enterprise plan
and no other. The plan is read the way the role editor reads it:
`ctx.planTier` when the kernel resolved it, otherwise `resolveOrgTier`, then
`canAccessSSO` from `@oxagen/billing`.

- **Writes that set SSO up are refused off Enterprise.** `create_sso_provider`,
  `update_sso_provider`, `verify_sso_domain`, `set_sso_group_roles`, and
  `set_sso_policy` turning `ssoRequired` on call `requireSsoEntitlement`
  (`packages/handlers/src/lib/sso.ts`) right after the org-role check. It
  throws a `HandlerError` with code `forbidden` and reason
  `sso_requires_enterprise`, which the kernel reports as a refusal. The
  handlers do not use `requireTier`, because the kernel does not classify its
  `TierDeniedError` and the caller would see a 500.
- **Cleanup stays open on every plan.** `list_sso_providers`,
  `delete_sso_provider`, and `set_sso_policy` turning `ssoRequired` off run on
  any plan, so an organization that left Enterprise can remove what it set
  up. The list reports `entitled`, and the Single sign-on and Roles pages use
  it to hide the setup controls and link to Billing.
- **Sign-in follows the plan.** Off Enterprise, sign-in through the
  organization's providers is refused and Require SSO does not apply
  (`packages/auth/src/sso/`). Members sign in with a password, which the
  forgot-password flow sets, or with Google or GitHub. The providers, their
  sealed settings, and the group mappings stay stored.

**Rejected: delete the providers on a downgrade.** A plan change is
reversible and a deletion is not. Keeping the rows costs nothing while sign-in
ignores them.

### SCIM is deferred

SCIM 2.0 provisioning and deprovisioning is not part of this change. It needs
its own endpoints, a bearer token per organization, session and API key
revocation, and an IdP rig to test Okta and Entra ID pushes against. Until it
lands, removing someone from the IdP blocks their next SSO sign-in but does not
end a session they hold or revoke their API keys. Issue #3734 carries the
handoff.

## Consequences

- An organization can sign its people in through its own IdP, verify the
  domain, and let IdP groups decide organization roles. Every change and every
  SSO sign-in is a row in `security.security_events`.
- The `sso.sign_in` row records the groups the IdP sent, the role granted, and
  the role before, so "the IdP sent no groups" reads differently from "nobody
  mapped these groups".
- A plugin upgrade that adds a secret field to `OIDCConfig` or `SAMLConfig`
  leaves that field in plaintext until `SSO_SECRET_PATHS` lists it. The
  capabilities build configs from an allowlist so the new field is not written
  until someone adds it.
- A preview deployment sends SSO callbacks to the host in `BETTER_AUTH_URL`.
  The OAuth proxy that relays Google and GitHub sign-in on previews does not
  relay SSO.
- The discovery guard (`assertPublicHttpUrl` in `@oxagen/config`) checks the
  URL as written and does not re-check after DNS resolves, so a name that
  resolves to a private address at connect time still passes. Closing that
  window needs a pinned-IP dialer, which every outbound guard in the repository
  shares.
- Deprovisioning stays a manual step on the Organization and API keys pages
  until SCIM ships.
