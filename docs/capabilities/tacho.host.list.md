# tacho.host.list

List the machines enrolled as Tacho hosts in this workspace, newest first, with status, mode, harness and version facts, liveness (last seen, last ingest, hooks and OpenTelemetry health, spool depth), and counters (sessions, unobserved sessions, open incidents). Cursor-paginated.

## Mode

**sync**

## Surface

- API only: `POST /v1/:org_slug/:workspace_slug/tacho/hosts`
- Authentication: session (org Owner, Admin, or Member)
- Capability name: `list_tacho_hosts`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity for the enrollment, ingest, bundle, and command capabilities, medium for the reads

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `status` | enum | no | `active`, `paused`, `suspended`, `revoked` |
| `limit` | integer | no | 1-200, default 50 |
| `cursor` | string | no | from a previous `nextCursor` |

## Output

| Field | Type | Description |
|---|---|---|
| `hosts` | object[] | host summaries |
| `nextCursor` | string or null | |

## Honesty

Records from a Tacho host are `client_attested` evidence (ADR-040 section 4): Oxagen can prove what was reported and detect tampering and gaps, and hook-based denial is enforcement at the harness, not at a gateway. Every session carries its `enforcementTier`; nothing here claims prevention where it has observation.
