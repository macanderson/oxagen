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
currencyOrUnit }`, integer strings: micros for a currency, whole units
otherwise), `targets` (measure → `{ allow, deny }` globs over a text measure),
`tools` (globs over `slug@version` or `slug`), `approval` (`{ humanAbove,
alwaysHumanFor, approvers }`), `purpose`, `validFrom`, `validTo`. Every read
returns the row plus `authority`: per limited measure the period key, the
settled and reserved values this period and `remaining`, the ledger's last
`balance_after` (INV-10).

## Roles

Any org Owner, Admin, Billing or Compliance, or a workspace Owner or Member.

## Side effects

- Postgres: insert `tools.mandates` (status `draft`, `requestedBy` the caller).

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `org_role_required`, `no_principal` | Not a member of the workspace. |
| `not_found` | `agent_not_found` | The agent is not in this workspace. |
| `conflict` | `agent_has_no_principal`, `no_tool_matches`, `measure_not_declared` | As `grant_mandate`: a request is checked by construction the same way. |

## SPEC references

- §6.9 part 3, §14 page 3; ADR-059
