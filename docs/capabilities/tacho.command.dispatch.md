# tacho.command.dispatch

Queue a control command for a host or one of its sessions (`docs/specs/tacho/spec.md` section 7.4): `pause`, `resume`, `cancel`, `message`, `revoke`, `refresh_bundle`, `kill`. The host receives it in its next ingest response or command fetch and reports the outcome. Host-level `pause`, `resume`, and `revoke` also change the host's status immediately so the next bundle carries it even if the command is never fetched. Soft effects (deny at the next boundary) are guaranteed while the hooks are installed; process termination (`kill`) is best effort and the outcome is recorded.

## Mode

**sync**

## Surface

- API only: `POST /v1/:org_slug/:workspace_slug/tacho/commands`
- Authentication: session (org Owner or Admin)
- Capability name: `dispatch_tacho_command`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity for the enrollment, ingest, bundle, and command capabilities, medium for the reads

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `hostEnrollmentId` | string | yes | |
| `sessionUuid` | uuid | no | targets one session; must belong to the host |
| `command` | enum | yes | see above |
| `payload` | object | no | `message` carries `{ text }`; `pause`/`cancel` may carry `{ reason }` |
| `expiresInS` | integer | no | 10-86400, default 3600 |

## Output

| Field | Type | Description |
|---|---|---|
| `commandId` | string | `tcm_` public id |
| `outcome` | `pending` | |
| `issuedAt`, `expiresAt` | string | RFC 3339 |

## Honesty

Records from a Tacho host are `client_attested` evidence (ADR-040 section 4): Oxagen can prove what was reported and detect tampering and gaps, and hook-based denial is enforcement at the harness, not at a gateway. Every session carries its `enforcementTier`; nothing here claims prevention where it has observation.
