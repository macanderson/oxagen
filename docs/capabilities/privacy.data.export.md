# privacy.data.export

**Domain:** privacy
**Mode:** async
**Scope:** user + org (Owner or Admin for org scope)
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Request a machine-readable ZIP archive of personal or organizational data under GDPR Article 20 (right to data portability). The request queues an async job and returns immediately with an `exportId`. Poll `GET /v1/:org/:ws/privacy/export/:exportId` to track status; when `status: "ready"`, a signed `downloadUrl` is returned.

## Input

| Field | Type | Notes |
|---|---|---|
| `scope` | `"user" \| "org"` | `"user"` — calling user's personal data. `"org"` — full organization data (requires Owner or Admin role). |
| `orgId` | `string (UUID)?` | Required when `scope = "org"`. |

## Output

| Field | Type | Notes |
|---|---|---|
| `exportId` | `string (UUID)` | Stable ID for polling. |
| `status` | `"queued" \| "processing" \| "ready" \| "failed"` | Always `"queued"` on initial response. |
| `downloadUrl` | `string (URL)?` | Present only when `status = "ready"`. Signed URL; expires in 24 hours. |

## ZIP archive contents

**User scope:**

| Path | Contents |
|---|---|
| `user-profile.json` | Name, email, created_at, org memberships |
| `conversations/` | Conversation metadata + messages |
| `api-keys.json` | Key metadata only (never values) |
| `audit-log.json` | Security events where user is subject |
| `generated-assets.json` | Asset metadata (URLs, prompts, types) |

**Org scope:** all of the above for each member, plus workspace configs, plugin metadata, and org-level audit events.

## Roles

- `scope: "user"` — any authenticated user (their own data only).
- `scope: "org"` — Owner or Admin role on the org.

## Side effects

- Postgres: inserts `auth.privacy_export_requests` row with `status = "queued"`.
- Security event emitted: `privacy.export_requested`.
- Inngest event dispatched: `privacy/export.process` (async ZIP assembly pipeline).

## Surfaces

- `POST /api/v1/{org}/{ws}/privacy/export`
- `GET /api/v1/{org}/{ws}/privacy/export/:exportId` (status polling)
- MCP tool `privacy_data_export`

## Errors

| code | meaning |
|---|---|
| `unauthorized` | No authenticated session. |
| `forbidden` | `scope: "org"` requested without Owner/Admin role. |
| `validation_error` | Input failed Zod parse. |
| `not_found` | `exportId` not found when polling. |
