# query_audit_log

Query the organization's security audit events (`security.security_events`) with structured filters (actor, capability, outcome, event type, workspace, time range) and page through them newest first. Read-only. Lets an admin, or the agent on their behalf, ask "who changed the billing plan last week?".

## Mode

**sync**

**Surfaces:** api, mcp, agent, cli

- API: `POST /v1/:org_slug/audit/log/query`
- MCP: `query_audit_log`
- Agent: callable (no approval required, risk: low)
- CLI: `oxagen audit log query`
- Capability name: `query_audit_log`
- Not billed (`noBillingGate: true`): reading the record is never a governed action.

## Access

Sensitivity **high**, IAM default-deny. Roles are checked in the handler, for the signed-in user or the creator of the API key:

| The call reads | Who may |
|---|---|
| the whole organization (no `workspaceId`, organization-level call) | org `Owner` or `Admin` |
| another workspace (`workspaceId` other than the call's own) | org `Owner` or `Admin` |
| the call's own workspace (named, or unnamed on a workspace-scoped call) | that workspace's `Owner`, or an org `Owner` or `Admin` |

A workspace-scoped call that names no workspace reads the whole organization for an org `Owner` or `Admin`. A refusal is `403 forbidden` (`org_role_required`, or `no_principal` for a key with no recorded creator). Every query is filtered by the caller's `orgId`.

## Input

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source` | `"all" \| "security"` | no | Which spine to query; default `all`. Both read `security_events`. |
| `eventType` | string | no | Exact event-type match (e.g. `billing.plan_changed`) |
| `actorUserId` | uuid | no | The acting user's id |
| `actorPublicId` | string | no | The acting user's public id (`usr_…`) |
| `capability` | string | no | Capability name |
| `outcome` | `"allow" \| "deny" \| "error" \| "success"` | no | Authz outcome |
| `workspaceId` | uuid | no | Restrict to one workspace |
| `from` | string (ISO-8601) | no | Inclusive lower bound on `occurredAt` |
| `to` | string (ISO-8601) | no | Exclusive upper bound on `occurredAt` |
| `limit` | number | no | Events per page, 1–200; default `50` |
| `offset` | number | no | Events to skip; default `0` |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `events` | AuditEvent[] | Matching events, newest first |
| `total` | number | Number of events in this page |
| `hasMore` | boolean | Whether more events exist past this page |
| `limit` | number | Echoed page size |
| `offset` | number | Echoed offset |

**AuditEvent**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | The security event's id |
| `source` | `"security"` | The spine the event came from |
| `eventType` | string | Event classification |
| `occurredAt` | string | ISO-8601 timestamp |
| `actorUserId` | string \| null | The acting user, when known |
| `actorPublicId` | string \| null | The acting user's public id, when the user exists |
| `workspaceId` | string \| null | Workspace the event names |
| `workspaceSlug` | string \| null | That workspace's slug |
| `capability` | string \| null | Capability for `capability.*` events |
| `outcome` | string \| null | Authz outcome |
| `ip` | string \| null | Client IP, when recorded |
| `userAgent` | string \| null | Client user agent, when recorded |
| `requestId` | string \| null | Request id |
| `detail` | object \| null (optional) | Stored event evidence. Approval-rule invalidations include the rule, tool, reason, and before/after facts. Legacy events return null. |

## Example

**Request:**

```http
POST /v1/acme/audit/log/query
Content-Type: application/json

{ "outcome": "deny", "from": "2026-09-01T00:00:00Z", "limit": 20 }
```

**Response:**

```json
{
  "events": [
    {
      "id": "0192d4a8-7c1e-7a00-8000-000000000e01",
      "source": "security",
      "eventType": "capability.invoke_denied",
      "occurredAt": "2026-09-14T18:42:10.000Z",
      "actorUserId": "0192d4a8-7c1e-7a00-8000-0000000005e1",
      "actorPublicId": "usr_7k2m9q4x8r1t5v3w6y0z2a",
      "workspaceId": "0192d4a8-7c1e-7a00-8000-00000000c0e1",
      "workspaceSlug": "core-platform",
      "capability": "set_spend_budget",
      "outcome": "deny",
      "ip": "203.0.113.7",
      "userAgent": "oxagen-cli/3.0",
      "requestId": "req_abc"
    }
  ],
  "total": 1,
  "hasMore": false,
  "limit": 20,
  "offset": 0
}
```

## Related

- [audit.events.export](audit.events.export.md) exports the same rows, signed.
