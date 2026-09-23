# execute_scim_request

**Domain:** org
**Mode:** sync
**Scope:** organisation (`scoped: false`, the organisation the SCIM token names)
**Surfaces:** none (`surfaces: []`; invoked only by the `/api/scim/v2` route in `apps/api/src/routes/scim.ts`)
**Sensitivity:** high · **Default effect:** allow (the token authorizes) · **Roles:** none
**Billing gate:** none · **Agent tool:** no
**Plan:** Enterprise.

Contract: `packages/oxagen/src/contracts/scim.request.ts`
Handler: `packages/handlers/src/scim.request.ts`
Protocol: `packages/handlers/src/lib/scim/service.ts`
Decision record: [ADR-145](../adr/ADR-145-enterprise-sso-behind-better-auth.md)
Guide: [Single sign-on](../guides/sso.md)

## Intent

Answer one SCIM 2.0 request (RFC 7643, RFC 7644) from the organisation's
identity provider (#3734). The route authenticates the bearer token and invokes
this capability, so every SCIM write runs through `invoke()`.

The handler refuses a call that carries a user or an API key, re-reads the
token (live, and this organisation's), and checks the Enterprise plan before
it reads anything else.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| tokenId | uuid | The `org.scim_tokens` row the route authenticated |
| method | `GET`, `POST`, `PUT`, `PATCH`, `DELETE` | |
| path | string | The path after `/api/scim/v2`, such as `/Users/<id>` |
| query | record of strings | `filter`, `startIndex`, `count`, `excludedAttributes` |
| body | JSON | The SCIM resource or PatchOp |

## Output

`{ status, body, location? }`, which the route writes as
`application/scim+json`.

## What it serves

| Resource | Methods |
| --- | --- |
| `/ServiceProviderConfig` | GET |
| `/ResourceTypes` | GET |
| `/Schemas` | GET |
| `/Users` | GET (filter `userName`, `externalId`, `emails.value` or `id` with `eq`), POST |
| `/Users/{id}` | GET, PUT, PATCH, DELETE |
| `/Groups` | GET (filter `displayName`, `externalId` or `id` with `eq`), POST |
| `/Groups/{id}` | GET, PUT, PATCH, DELETE |

## Side effects

1. **POST /Users** creates the Oxagen account, or links the one that has the
   `userName`, and gives it a principal in the organisation. It grants no
   role. Audited as `scim.user_provisioned`.
2. **PUT or PATCH /Users/{id}** updates the email, name, and `externalId`.
   Audited as `scim.user_updated`.
3. **`active: false` or DELETE** runs the member removal transaction
   (`packages/database/src/member-lifecycle.ts`): every session ended, every
   key the person created in the organisation revoked, each Tacho host they
   enrolled revoked, each unused enrollment token expired, every role
   assignment and the membership removed. Audited as
   `scim.user_deprovisioned`, with `auth.sign_out`, `security.session_revoked`,
   `api_key.revoked`, and `tacho.host_revoked` rows per credential.
4. **A group change** recomputes the organisation role of each person it
   touches through `org.sso_group_roles`, matched on the group's display name
   or external id. Audited as `scim.group_changed`.

## Errors

Every refusal is a SCIM error body with `status`, `scimType` where one
applies, and `detail`.

- `401`: the token is revoked or names another organisation. Audited as
  `scim.request_denied`.
- `403`: the organisation is not on the Enterprise plan, or the person is an
  Owner. Audited as `scim.request_denied`.
- `400` `invalidValue`: the `userName` is not on one of the organisation's
  verified SSO domains. Audited as `scim.request_denied`.
- `400` `invalidFilter`, `invalidSyntax`, `invalidPath`: an unsupported filter
  or a malformed body.
- `404`: no such user or group in this organisation.
- `409` `uniqueness`: the `userName` or group name is taken.
