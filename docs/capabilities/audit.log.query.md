# audit.log.query

Query the org's security and automation audit events (`security_events` + `playbook_events`) with structured filters — actor, capability, outcome, event type, time range — returning a unified, newest-first feed. Read-only and strictly org-scoped. Lets an admin (or the agent on their behalf) ask "who changed the billing plan last week?".

## Mode
**sync**

## Surfaces
- API: `POST /v1/audit/log/query`
- MCP: `audit.log.query`
- Agent: callable (no approval required, risk: low)

## Access
Admin-level. Default roles: org `Owner`/`Admin` and workspace `Owner`. Sensitivity: **high**. Tenant isolation is enforced in the handler — every underlying query is filtered by the caller's `orgId`.

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source` | `"all" \| "security" \| "playbook"` | no | Which spine(s) to query; default `all` |
| `eventType` | string | no | Exact event-type match (e.g. `billing.plan_changed`, `run_completed`) |
| `actorUserId` | string | no | Filter security events by acting user id |
| `capability` | string | no | Filter security events by capability name |
| `outcome` | `"allow" \| "deny" \| "error" \| "success"` | no | Filter security events by authz outcome |
| `playbookRunId` | string | no | Filter playbook events to a single run |
| `workspaceId` | string | no | Restrict to one workspace (default: all in org) |
| `from` | string (ISO-8601) | no | Inclusive lower bound on `occurredAt` |
| `to` | string (ISO-8601) | no | Exclusive upper bound on `occurredAt` |
| `limit` | number | no | Max events 1–200; default `50` |
| `offset` | number | no | Pagination offset; default `0` |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `events` | AuditEvent[] | Matching events, newest first |
| `total` | number | Number of events in this page |
| `hasMore` | boolean | Whether more events exist beyond this page |
| `limit` | number | Echoed page size |
| `offset` | number | Echoed offset |

**AuditEvent**
| Field | Type | Description |
|-------|------|-------------|
| `source` | `"security" \| "playbook"` | Which spine the event came from |
| `eventType` | string | Event classification |
| `occurredAt` | string | ISO-8601 timestamp |
| `actorUserId` | string \| null | Acting user, when known (security) |
| `workspaceId` | string \| null | Workspace scope |
| `capability` | string \| null | Capability for `capability.*` security events |
| `outcome` | string \| null | Authz outcome (security) |
| `requestId` | string \| null | Request id (security) |
| `playbookRunId` | string \| null | Run id (playbook) |
| `sequence` | number \| null | Per-run monotonic counter (playbook) |
| `eventData` | object \| null | Structured payload (playbook) |

## Example

**Request:**
```http
POST /v1/audit/log/query
Content-Type: application/json

{ "source": "security", "capability": "billing.subscription_upgrade.start", "from": "2024-01-01T00:00:00Z", "limit": 20 }
```

**Response:**
```json
{
  "events": [
    {
      "source": "security",
      "eventType": "capability.invoked",
      "occurredAt": "2024-01-03T18:42:10.000Z",
      "actorUserId": "u_8f2",
      "workspaceId": "ws_1",
      "capability": "billing.subscription_upgrade.start",
      "outcome": "success",
      "requestId": "req_abc",
      "playbookRunId": null,
      "sequence": null,
      "eventData": null
    }
  ],
  "total": 1,
  "hasMore": false,
  "limit": 20,
  "offset": 0
}
```
