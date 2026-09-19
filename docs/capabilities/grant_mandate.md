# grant_mandate

**Domain:** mandate
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent (requires approval)
**Sensitivity:** high
**Metering:** none (`noBillingGate`, ADR-052 exclusion 2)

## Intent

Grant one agent bounded, expiring authority for a consequence (MC spec §6.9
part 3, ADR-059): limits over the tool's declared measures, allowed targets,
tool patterns, the mandate's own approval rule, a purpose and a validity
window. With `requestId` the draft `request_mandate` created becomes
active with the granter's body.

The mandate shape (spec §6.9 part 3): `agentId` (`agt_…`), `consequenceTags`,
`limits` (measure → `{ perCall?, perPeriod?, period: daily | weekly | monthly,
currencyOrUnit }`, integer strings: micros for a currency, whole units
otherwise), `targets` (measure → `{ allow, deny }` globs over a text measure),
`tools` (globs over `slug@version` or `slug`), `approval` (`{ humanAbove,
alwaysHumanFor, approvers }`), `purpose`, `validFrom`, `validTo`. Every read
returns the row plus `authority`: per limited measure the period key, the
settled and reserved values this period and `remaining`: `perPeriod` less
those two, floored at zero, the figure the gate reserves against.

## Roles

The org roles the workspace names for every consequence tag on the mandate
(`consequence_roles` on the workspace over `DEFAULT_CONSEQUENCE_ROLES`:
`moves_money` and `changes_entitlement` → Owner, Billing; `changes_access` →
Owner, Admin, Compliance; the rest → Owner, Admin). Checked in the handler
(INV-29); the satisfying role is recorded as `roleAtGrant`.

## Side effects

- Postgres: insert `tools.mandates` (status `active`), or update the draft.
- Security event `mandate.granted`.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `org_role_required`, `no_role_covers_all_tags`, `no_principal` | The caller holds no role the workspace names for every tag. |
| `not_found` | `agent_not_found`, `mandate_not_found` | The agent or the draft is not in this workspace. |
| `conflict` | `agent_has_no_principal` | The agent has no delegated principal to bind to. |
| `conflict` | `no_tool_matches` | A tool pattern matches no declared, enabled tool carrying a consequence tag. |
| `conflict` | `measure_not_declared` | A matched tool's active version declares no measure for a limit or target the mandate names: denied by construction (§6.9 rule 1). |
| `conflict` | `measure_unit_mismatch` | A matched tool declares that measure in a different unit from the one the limit is denominated in. The gate reads a call in the unit the tool declares, so a limit in any other unit is enforced as a figure nobody entered — a `storage` measure declared in GB, limited at "50 bytes", would admit a call of 50 GB. |
| `conflict` | `not_a_draft` | `requestId` names a mandate that is not a draft. |
| `conflict` | `agent_retired` | The agent is retired (`status: archived`): its principal is suspended and can never draw on a mandate. Refused for a fresh grant and for activating a draft whose agent retired after the request was made (ADR-106). |

## SPEC references

- §6.9 part 3, App. A.5, App. E; ADR-059
