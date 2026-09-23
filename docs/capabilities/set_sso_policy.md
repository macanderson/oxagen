# set_sso_policy

**Domain:** org
**Mode:** sync
**Scope:** organisation (`scoped: false`, requires an orgId, no workspace)
**Surfaces:** api, mcp
**Sensitivity:** high · **Default effect:** deny · **Roles:** org Owner, Admin
**Billing gate:** none · **Agent tool:** no
**Plan:** Enterprise to turn Require SSO on. Turning it off works on any plan.

Contract: `packages/oxagen/src/contracts/org.sso.policy.set.ts`
Handler: `packages/handlers/src/org.sso.policy.set.ts`
API: `PUT /v1/:org/:workspace/org/sso/policy`
MCP: `apps/mcp/src/tools/org.sso.policy.set.ts`
Decision record: [ADR-144](../adr/ADR-144-enterprise-sso-behind-better-auth.md)

## Intent

Require SSO for the organisation, or stop requiring it. While it is
required, members other than Owners reach the organisation only through a
session one of its SSO providers established, and password sign-in is
refused for the providers' email domains. Owners stay exempt so an identity
provider outage cannot lock the organisation out.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| ssoRequired | boolean | `true` to require SSO, `false` to stop |

## Output

`{ policy: { ssoRequired } }`.

## Side effects

1. Upsert `security.org_security_policy.sso_required`. The MFA columns on the
   same row are left as they are.
2. **Audit** an `sso.policy_updated` event with the new value.

## Errors

- `forbidden` / `sso_requires_enterprise`: `ssoRequired: true` while the
  organisation is not on the Enterprise plan. The role check runs first.
- `conflict` / `no_verified_provider`: `ssoRequired: true` while no provider
  in the organisation has a verified domain. The check runs in the same
  transaction as the write.
