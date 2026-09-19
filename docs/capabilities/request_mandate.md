# request_mandate

**Domain:** mandate
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Sensitivity:** medium
**Metering:** none (`noBillingGate`)

## Intent

An agent operator asks for authority (Agents › mandates): the same shape as
`grant_mandate`, recorded as a `draft` for the accountable role to grant
(`grant_mandate` with `requestId`) or decline (`revoke_mandate`). A draft
grants nothing: the decision gate reads active mandates only.

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
fact, always resolved.

## Roles

Any org Owner, Admin, Billing or Compliance, or a workspace Owner or Member.

## Side effects

- Postgres: insert `tools.mandates` (status `draft`, `requestedBy` the caller).

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `org_role_required`, `no_principal` | Not a member of the workspace. |
| `not_found` | `agent_not_found` | The agent is not in this workspace. |
| `conflict` | `agent_has_no_principal`, `no_tool_matches`, `measure_not_declared`, `measure_unit_mismatch`, `measure_kind_conflict` | As `grant_mandate`: a request is checked by construction the same way, including that each limit is denominated in the unit its measure is declared in, and that matched tools agree on what a limited measure counts (ADR-108). |
| `conflict` | `agent_retired` | The agent is retired (`status: archived`): its principal is suspended and can never draw on a mandate, so no new draft is recorded against it (ADR-106). |

## SPEC references

- §6.9 part 3, §14 page 3; ADR-059
