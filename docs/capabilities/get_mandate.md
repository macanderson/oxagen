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
| `settle` | `release`), `measure`, `value`, `unitOrCurrency`, `measureKind`
(`money` or `count`, ADR-108, stamped on the row when it was written and
never re-derived; null only on a row written before this field existed),
`externalEffectId` (settle rows: the payment, migration, message or
deployment id the tool returned), `periodKey`, `balanceAfter`, `at`.

The mandate shape (spec §6.9 part 3): `agentId` (`agt_…`), `consequenceTags`,
`limits` (measure → `{ perCall?, perPeriod?, period: daily | weekly | monthly,
currencyOrUnit, kind? }`, integer strings: micros for a currency, whole units
otherwise), `targets` (measure → `{ allow, deny }` globs over a text measure),
`tools` (globs over `slug@version` or `slug`), `approval` (`{ humanAbove,
alwaysHumanFor, approvers }`), `purpose`, `validFrom`, `validTo`. Every read
returns the row plus `authority`: per limited measure the period key, the
settled and reserved values this period and `remaining`: `perPeriod` less
those two, floored at zero, the figure the gate reserves against.

`authority[].kind` (`money` or `count`, ADR-108) is always present and
resolved: the fact the writing handler stamped from the tool declaration, or,
for a mandate whose limits were written before ADR-108, the documented
fallback, resolved before this read returns. Nothing downstream of this
response should decide money-or-count from `currencyOrUnit`'s spelling; `kind`
already answers it.

## App surface

The mandate page, `/{org}/{ws}/mandates/{mandate}`: the four summary tiles, the
ledger with its search, State facet and pager, the grant panel and the
reconciliation panel. The read goes through `data/live/mandates.ts`. Two of the
row's fields do not reach the page: `id` and `toolCallId` are raw database uuids
and the view model admits neither (INV-11), so the ledger's *Call* column names
the measure the movement drew and says under the table that nothing resolves the
call to a tool version. `balanceAfter` is not rendered: the tiles carry the
ledger's own accounting.

## Readers

As `list_mandates` (ADR-107): the accountable office reads every mandate; a
workspace Owner or Member reads the mandates of agents they created, and the
mandates they requested themselves for any agent. An enterprise org's own IAM
configuration can widen that with any other explicit allow path naming this
capability (a custom `role_grants` entry, a direct grant, or an enforced
allow policy), and an agent run authorized to call it clears the kernel's
delegation-ceiling resolver on any tier: both take the same narrowed-reader
scope without the built-in workspace check, per `list_mandates.md`'s
Readers section, which this capability shares in full.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `org_role_required`, `no_principal` | Neither an accountable office role, a workspace Owner/Member reading an agent they created or a mandate they requested, nor (on an enterprise org) any other explicit IAM allow path admits the caller. |
| `not_found` | `mandate_not_found` | Not in this workspace. |

## SPEC references

- §6.9 part 3, §6.10; ADR-059; ADR-108 (the measure kind on `limits` and
  `authority`)
