# export_audit_events

Export the organization's security audit events as CSV or NDJSON, signed with HMAC-SHA256 so an auditor can verify the file was not changed after download. The filters are `query_audit_log`'s, so the rows a reader pages through are the rows the export signs.

## Mode

**sync**

**Surfaces:** api, mcp

- API: `POST /v1/:org_slug/audit/events/export`
- MCP: `export_audit_events`
- Capability name: `export_audit_events`
- Not billed (`noBillingGate: true`). Every tier may export (spec §20 row 3).

## Access

Org `Owner` or `Admin`, checked in the handler for the signed-in user or the creator of the API key; any other role is `403 forbidden`. Sensitivity **high**, IAM default-deny.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `format` | `"csv" \| "ndjson"` | no | default `csv` |
| `eventType` | string | no | exact match |
| `actorUserId` | uuid | no | the acting user's id |
| `actorPublicId` | string | no | the acting user's public id (`usr_…`) |
| `capability` | string | no | capability name |
| `outcome` | `"allow" \| "deny" \| "error" \| "success"` | no | |
| `workspaceId` | uuid | no | one workspace |
| `from` | string (ISO-8601) | no | inclusive lower bound |
| `to` | string (ISO-8601) | no | exclusive upper bound |

Any other key is refused.

## Output

| Field | Type | Description |
|---|---|---|
| `format` | `"csv" \| "ndjson"` | as asked |
| `body` | string | the file |
| `signature` | string | hex HMAC-SHA256 of `body` |
| `algorithm` | `"HMAC-SHA256"` | |
| `rowCount` | integer | events in the file |

Columns, in order: `id, occurred_at, event_type, outcome, actor_user_id, org_id, workspace_id, capability, ip, user_agent, request_id, detail`. Scalar fields the event does not record are empty. `detail` carries stored event evidence as a JSON object in NDJSON and a JSON-encoded field in CSV. Events without detail carry `null` in NDJSON and an empty CSV field. Approval-rule invalidations include the rule, tool, reason, and before/after facts. The signature covers these facts as part of the body. CSV is RFC 4180 with CRLF line ends and a header line; NDJSON is one object per line with every column as a key.

## Signature

The key is `AUDIT_EXPORT_SIGNING_SECRET` when it is set to at least 16 characters, otherwise `BETTER_AUTH_SECRET`. Recompute `HMAC-SHA256(key, body)` over the exact bytes of `body` and compare with `signature`.

## Bounds and failures

- An export carries at most 50,000 events. A filter matching more is `400 invalid_input`; narrow the time range and export again.
- A store failure during the walk fails the call. No partial file is ever signed.

## Example

```http
POST /v1/acme/audit/events/export
Content-Type: application/json

{ "format": "csv", "outcome": "deny", "from": "2026-09-01T00:00:00Z" }
```

```json
{
  "format": "csv",
  "body": "id,occurred_at,event_type,outcome,actor_user_id,org_id,workspace_id,capability,ip,user_agent,request_id,detail\r\n…",
  "signature": "5f0c…",
  "algorithm": "HMAC-SHA256",
  "rowCount": 12
}
```
