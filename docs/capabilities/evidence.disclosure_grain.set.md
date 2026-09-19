# set_disclosure_grain

Set how much a worker is told when a witness it cannot see fails (Mission Control spec §8.5 invariant 3; ADR-064). `L0` is the word pass or fail and nothing else; `L1` names the criterion, `L2` describes a symptom, `L3` hands over a regenerated reproduction. A workspace with no stored grain is `L0`.

## Mode

**sync**

## Surface

- API: `PUT /v1/:org_slug/:workspace_slug/evidence/disclosure-grain`
- MCP: none. A person decides the grain; an agent's credential cannot.
- Authentication: a signed-in session only (org Owner or Admin). Every API-key caller is refused with `forbidden` (`session_required`).
- Capability name: `set_disclosure_grain`
- Not billed (`noBillingGate: true`): changing a setting is never a governed action (ADR-052 exclusion 2). IAM default-deny; high sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `grain` | enum | yes | `L0`, `L1`, `L2`, `L3` |

## Output

| Field | Type | Description |
|---|---|---|
| `grain` | enum | the grain now stored |
| `previousGrain` | enum | the grain in force before the call; `L0` when none was stored |
| `changedAt` | string or null | RFC 3339: when the stored grain last changed; null when nothing was ever stored and `L0` was asked for |

## Errors

| Code | Reason | When |
|---|---|---|
| `forbidden` | `session_required` | an API-key caller, or no signed-in user |
| `forbidden` | `org_role_required` | a Member, Billing or Viewer user |

## Audit

Every change writes `evidence.disclosure_grain_changed` to the security log with the acting user, the org and the workspace. Asking for the grain already in force writes nothing and emits nothing, and answers the instant it was stored.
