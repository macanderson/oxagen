# tacho.session.list

List Tacho sessions in this workspace, newest first. Root sessions only unless `includeChildren` is set; a subagent is its own chain linked by `parentSessionUuid`. Filter by host, outcome, or start time. Cursor-paginated.

## Mode

**sync**

## Surface

- API only: `POST /v1/:org_slug/:workspace_slug/tacho/sessions`
- Authentication: session (org Owner, Admin, or Member)
- Capability name: `list_tacho_sessions`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity for the enrollment, ingest, bundle, and command capabilities, medium for the reads

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `hostEnrollmentId` | string | no | |
| `outcome` | enum | no | `running`, `completed`, `aborted`, `crashed`, `unknown` |
| `since` | string | no | RFC 3339; sessions started at or after |
| `includeChildren` | boolean | no | default `false` |
| `limit` | integer | no | 1-200, default 50 |
| `cursor` | string | no | |

## Output

| Field | Type | Description |
|---|---|---|
| `sessions` | object[] | session summaries |
| `nextCursor` | string or null | |

## Honesty

Records from a Tacho host are `client_attested` evidence (ADR-040 section 4): Oxagen can prove what was reported and detect tampering and gaps, and hook-based denial is enforcement at the harness, not at a gateway. Every session carries its `enforcementTier`; nothing here claims prevention where it has observation.
