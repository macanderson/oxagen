# revoke_mandate

**Domain:** mandate
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent (requires approval)
**Sensitivity:** high
**Metering:** none (`noBillingGate`)

## Intent

End a mandate with a reason. Under the mandate row lock every reservation
held by a call parked for approval is released and those approval rows
expire, so revoking ends in-flight calls that have not dispatched (§6.9). A
draft is revoked the same way: that is how a request is declined.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `mandateId` | `string` | `mnd_…` |
| `reason` | `string` | 1–2000 characters, recorded as `revokedReason`. |

## Output

The mandate, status `revoked`.

## Roles

The consequence roles of every tag on the mandate, as `grant_mandate`.

## Side effects

- Postgres: `tools.mandates.status = revoked`; `release` rows in
  `tools.mandate_ledger` for parked calls; parked `agent.approval_requests`
  rows resolved `expired`.
- Security event `mandate.revoked`.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `org_role_required`, `no_role_covers_all_tags`, `no_principal` | Not an accountable role for every tag. |
| `not_found` | `mandate_not_found` | Not in this workspace. |
| `conflict` | `mandate_ended` | Already expired or revoked. |

## SPEC references

- §6.9 part 3 ("Revoking a mandate ends in-flight calls that have not dispatched"), App. E; ADR-059
