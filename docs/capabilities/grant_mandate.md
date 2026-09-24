# grant_mandate

**Domain:** mandate
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
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
currencyOrUnit, kind? }`, integer strings: micros for a currency, whole units
otherwise), `targets` (measure → `{ allow, deny }` globs over a text measure),
`tools` (globs over `slug@version` or `slug`), `approval` (`{ humanAbove,
alwaysHumanFor, approvers }`), `purpose`, `validFrom`, `validTo`. Every read
returns the row plus `authority`: per limited measure the period key, the
settled and reserved values this period and `remaining`: `perPeriod` less
those two, floored at zero, the figure the gate reserves against.

`limits[measure].kind` (`money` or `count`, ADR-108) is stamped by the
handler from the tool declaration `assertToolsDeclareMeasures` already
validates, never taken from the request: any `kind` a caller sends is
discarded and recomputed. `authority[].kind` on every read carries the same
fact, always resolved: a limit written before ADR-108 has no stored `kind`
and takes the documented fallback at read time, but nothing a `get_mandate` or
`list_mandates` caller sees is ever unresolved.

## App surface

The mandates ledger on the Tools page's Policy tab, `/{org}/{ws}/tools/policy`.
**Grant a mandate** in the ledger header opens a blank grant with an agent
picker. **Grant** on a requested row opens the same dialog on that draft and
sends its id as `requestId`. Both controls are drawn for an org Owner, Admin,
Billing, or Compliance member, the four roles a consequence can name. The
handler still decides each grant by its tags.

The dialog writes every limit and `humanAbove` threshold exactly as typed, in
whole units, and refuses a unit that is a currency code. Whether a measure is
money is a property of the tool version's declaration, which no read the app
makes returns. Grant a money limit over the API or MCP. The dialog holds one
counterparty rule and one `humanAbove` threshold. Grant more over the API or
MCP. A requested draft that holds more than the dialog can carry (a money
limit, a second limit, target rule or threshold, a calls limit that is not a
daily total, or a tool pattern or target glob with a comma in it, which the
dialog's comma-separated fields would split in two) opens for review with no
**Grant** button: the handler replaces the draft's body with the granter's, so
granting it from the dialog would drop or widen the part it cannot hold.

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
| `conflict` | `measure_kind_conflict` | Two tools matched by the mandate's patterns declare the same limited measure with different kinds (one `amount`, one `count`); write time cannot resolve which governs, so the grant is refused rather than picking one (ADR-108). |
| `conflict` | `not_a_draft` | `requestId` names a mandate that is not a draft. |
| `conflict` | `agent_retired` | The agent is retired (`status: archived`): its principal is suspended and can never draw on a mandate. Refused for a fresh grant and for activating a draft whose agent retired after the request was made (ADR-106). |

## SPEC references

- §6.9 part 3, App. A.5, App. E; ADR-059
