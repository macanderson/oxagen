# advance_onboarding

The onboarding gate's operator-driven transitions (#2967): `wrap` ("I have already installed it — continue") and `run` (Back). `unlocked` is accepted by the schema and refused by the handler with `conflict: first_frame_required`: the run step completes only when `ingest_tacho_events` accepts the organization's first frame, never on a click and never on a timer. A gate that is already open refuses every transition with `conflict: already_unlocked`; a workspace that is not the gate's has no gate to move (`not_found: gate_not_found`). Moving to the step the gate is already on changes nothing and answers the row's last change.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/onboarding/advance`
- MCP: none. The MCP context carries an API key and no user, and the handler's role check refuses a context without one (`forbidden: no_principal`)
- Authentication: session; org Owner or Admin, checked by the handler (INV-29)
- Capability name: `advance_onboarding`
- Not billed (`noBillingGate: true`); IAM default-deny; medium sensitivity

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `to` | enum | yes | `wrap`, `run`, `unlocked` (refused by the handler) |

## Output

| Field | Type | Description |
|---|---|---|
| `step` | enum | the step the gate is on after the call |
| `changedAt` | string | RFC 3339; when the gate last changed |

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no signed-in user; a user who is not an org Owner or Admin |
| `conflict` | `first_frame_required` | `to: "unlocked"` |
| `conflict` | `already_unlocked` | the gate is open |
| `not_found` | `gate_not_found` | the workspace is not the organization's onboarding workspace |
