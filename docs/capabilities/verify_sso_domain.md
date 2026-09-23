# verify_sso_domain

**Domain:** org
**Mode:** sync
**Scope:** organisation (`scoped: false`, requires an orgId, no workspace)
**Surfaces:** api, mcp
**Sensitivity:** high · **Default effect:** deny · **Roles:** org Owner, Admin
**Billing gate:** none · **Agent tool:** no
**Plan:** Enterprise. On any other plan the call is refused.

Contract: `packages/oxagen/src/contracts/org.sso.verify_domain.ts`
Handler: `packages/handlers/src/org.sso.verify_domain.ts`
API: `POST /v1/:org/:workspace/org/sso/providers/:providerId/verify-domain`
MCP: `apps/mcp/src/tools/org.sso.verify_domain.ts`
Decision record: [ADR-144](../adr/ADR-144-enterprise-sso-behind-better-auth.md)

## Intent

Prove the organisation owns the provider's email domain. Until this succeeds
the provider signs nobody in.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| providerId | slug | The provider whose domain to verify |

Publish the TXT record from the provider view first:

```
_oxagen-sso.acme.com  TXT  "oxagen-sso-verification=<token>"
```

## Output

`{ provider }`, with `domainVerified: true`.

## Side effects

1. Look up TXT records at `_oxagen-sso.<domain>`. A value split into chunks
   is joined before the comparison, and the match is exact.
2. Set `domain_verified` to true.
3. **Audit** an `sso.domain_verified` event. Verifying a domain that is
   already verified looks the record up again and emits nothing.

## Errors

- `forbidden` / `sso_requires_enterprise`: the organisation is not on the
  Enterprise plan. The role check runs first.
- `not_found` / `sso_provider_not_found`: no such provider in this
  organisation.
- `conflict` / `dns_record_not_found`: no matching TXT record. The message
  names the record and value to publish. Wait for DNS to update, then call
  again.
