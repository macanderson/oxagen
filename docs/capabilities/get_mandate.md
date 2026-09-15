# get_mandate

**Domain:** mandate
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Sensitivity:** medium
**Metering:** none (`noBillingGate`, a console read)

## Intent

One mandate with its remaining authority by measure and its ledger rows
newest first: the mandate page (tiles, the ledger, the grant).

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `mandateId` | `string` | `mnd_…` |
| `ledgerLimit` | `number` | 1–500, default 100. |

## Output

`{ mandate, ledger }`. A ledger row: `id`, `toolCallId`, `kind` (`reserve`
| `settle` | `release`), `measure`, `value`, `unitOrCurrency`,
`externalEffectId` (settle rows: the payment, migration, message or
deployment id the tool returned), `periodKey`, `balanceAfter`, `at`.

The mandate shape (spec §6.9 part 3): `agentId` (`agt_…`), `consequenceTags`,
`limits` (measure → `{ perCall?, perPeriod?, period: daily | weekly | monthly,
currencyOrUnit }`, integer strings: micros for a currency, whole units
otherwise), `targets` (measure → `{ allow, deny }` globs over a text measure),
`tools` (globs over `slug@version` or `slug`), `approval` (`{ humanAbove,
alwaysHumanFor, approvers }`), `purpose`, `validFrom`, `validTo`. Every read
returns the row plus `authority`: per limited measure the period key, the
settled and reserved values this period and `remaining`, the ledger's last
`balance_after` (INV-10).

## Readers

As `list_mandates`: the accountable office, or the operator of the agent.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `org_role_required`, `no_principal` | Neither the office nor the agent's operator. |
| `not_found` | `mandate_not_found` | Not in this workspace. |

## SPEC references

- §6.9 part 3, §6.10; ADR-059
