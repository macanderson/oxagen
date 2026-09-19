# update_mandate_limits

**Domain:** mandate
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent (requires approval)
**Sensitivity:** high
**Metering:** none (`noBillingGate`)

## Intent

Change limits on an active mandate: the limits, the targets, the mandate's
own approval rule and the validity end. Omitted fields are unchanged. The
ledger keeps its rows; the next reservation and every read take the new
`perPeriod` as the ceiling over what the period has already drawn, so a
ceiling lowered under what is drawn reads as `0` remaining until the period
rolls. A limit or target over a
measure a matched tool does not declare is refused as `grant_mandate`
refuses it.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `mandateId` | `string` | `mnd_…` |
| `limits` | `MandateLimits?` | Replaces the limits as a whole. |
| `targets` | `MandateTargets?` | Replaces the targets as a whole. |
| `approval` | `MandateApproval?` | Replaces the approval rule. |
| `validTo` | `string?` | ISO instant after `validFrom`. |

At least one field is named.

## Output

The mandate.

## App surface

The Change limits dialog in the mandate page's header,
`/{org}/{ws}/mandates/{mandate}`. Because this capability **replaces** `limits`
rather than merging into it, the app reads the mandate first (`get_mandate`,
`ledgerLimit: 1`) and lays the edited measure over the stored record, so every
bound the operator did not touch is resubmitted exactly as recorded. A field left
blank in the dialog therefore leaves that measure's bound as it is; removing a
limit altogether means sending a `limits` record without it, which is this
capability over the API or MCP.

The dialog writes counts only and stores each figure exactly as typed: whether a
measure is money is a property of the tool version's declaration, which no read
answers, so a money limit is changed over the API or MCP by a caller that holds
the declaration.

## Roles

The consequence roles of every tag on the mandate, as `grant_mandate`.

## Side effects

- Postgres: update `tools.mandates`.
- Security event `mandate.limits_changed`.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `org_role_required`, `no_role_covers_all_tags`, `no_principal` | Not an accountable role for every tag. |
| `not_found` | `mandate_not_found` | Not in this workspace. |
| `conflict` | `mandate_ended` | Only an active mandate changes. |
| `conflict` | `validity_inverted` | `validTo` at or before `validFrom`. |
| `conflict` | `no_tool_matches`, `measure_not_declared`, `measure_unit_mismatch` | Denied by construction, the same checks `grant_mandate` runs. |

## SPEC references

- §6.9 part 3 (Change limits), App. E; ADR-059
