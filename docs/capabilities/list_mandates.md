# list_mandates

**Domain:** mandate
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Sensitivity:** medium
**Metering:** none (`noBillingGate`, a console read)

## Intent

The ledger view the accountable office reads (Tools › mandates) and the
mandates one agent holds (Agents › mandates), newest first, with remaining
authority by measure from the ledger.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `agentId` | `string?` | Only this agent's mandates (`agt_…`). |
| `status` | `draft \| active \| expired \| revoked`? | Only this status. |
| `limit` | `number` | 1–100, default 50. |

## Output

`{ items: Mandate[] }`.

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

An org Owner, Admin, Billing or Compliance reads every mandate in the
workspace; any other signed-in user reads the mandates of agents they
created.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `no_principal` | No signed-in user on the request. |

## SPEC references

- §6.9 part 3 (the ledger the accountable office reads), App. E; ADR-059
