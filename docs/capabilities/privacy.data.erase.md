# privacy.data.erase

**Domain:** privacy
**Mode:** async
**Scope:** user + org (Owner only for org scope)
**Surfaces:** api, mcp, agent
**Risk level:** critical
**Default effect:** deny (requires explicit `confirm: true`)

## Intent

Request erasure of personal or organizational data under GDPR Article 17 (right to erasure). All active sessions are revoked immediately. A hard-delete is scheduled after a configurable grace period (default: 30 days, set via `PRIVACY_ERASURE_GRACE_DAYS`).

A `privacy/erasure.execute` Inngest event is emitted — subscribe to this via webhook to trigger downstream cleanup in CRM, analytics, and internal systems.

## Input

| Field | Type | Notes |
|---|---|---|
| `scope` | `"user" \| "org"` | `"user"` — calling user's own account. `"org"` — entire organization (Owner only). |
| `orgId` | `string (UUID)?` | Required when `scope = "org"`. |
| `confirm` | `true` (literal) | Must be explicitly `true`. Prevents accidental erasure. |

## Output

| Field | Type | Notes |
|---|---|---|
| `requestId` | `string (UUID)` | Stable ID for the erasure request. |
| `status` | `"queued"` | Always `"queued"` — erasure is deferred by the grace period. |
| `effectiveAt` | `string (ISO datetime)` | When the hard-delete will execute (now + grace period). |

## Grace period

Default: 30 days (`PRIVACY_ERASURE_GRACE_DAYS=30`). Set to `0` in test environments for immediate erasure. Contact `privacy@oxagen.ai` within the grace period to cancel.

## Roles

- `scope: "user"` — any authenticated user (their own account only).
- `scope: "org"` — Owner role only.

## Side effects

**Immediate (at request time):**
- Sessions revoked for the user (or all org members if org scope).
- Postgres: inserts `auth.privacy_erasure_requests` row with `status = "queued"`.
- Security event emitted: `privacy.erasure_requested` or `privacy.org_erasure_requested`.

**Deferred (after grace period):**
- Inngest event dispatched: `privacy/erasure.execute`.
- User PII anonymised: name → "Deleted User", email → `<uuid>@deleted.invalid`.
- Personal data rows hard-deleted: conversations, messages, api_keys, generated assets.
- Org scope: all members offboarded + all org data cascade-deleted.

## Webhook integration

Subscribe to `privacy/erasure.execute` to hook in downstream cleanup:

```json
{
  "name": "privacy/erasure.execute",
  "data": {
    "requestId": "<uuid>",
    "userId": "<uuid>",
    "orgId": "<uuid>",
    "scope": "user",
    "scheduledAt": "2026-07-09T..."
  }
}
```

## Surfaces

- `POST /api/v1/{org}/{ws}/privacy/erase`
- MCP tool `privacy_data_erase` (marked `destructiveHint: true`, requires approval)
- App: Account → Privacy (user scope), Org Settings → Privacy (org scope)

## Errors

| code | meaning |
|---|---|
| `unauthorized` | No authenticated session. |
| `forbidden` | `scope: "org"` requested without Owner role. |
| `validation_error` | Input failed Zod parse or `confirm` is not `true`. |
