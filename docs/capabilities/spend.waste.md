# spend.waste

Spend the frames show bought nothing, by cause, with the runs that prove it (Mission Control spec §12.8; ADR-060). Each cause is a pattern read off the `cost.run_totals` rows of the active workspace, never a guess.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/spend/waste`
- MCP: `list_waste`
- Authentication: session (org Owner, Admin, Billing or Member; workspace Owner or Member)
- Capability name: `list_waste`
- Not billed (`noBillingGate: true`). IAM default-deny; medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `period` | object | yes | `{ from, to }`, UTC days, `to` on or after `from` |

## Output

| Field | Type | Description |
|---|---|---|
| `period` | object | as asked |
| `wasted` | cost or null | the total across causes with its basis; null when no run showed waste |
| `share` | number or null | wasted over the period's priced spend; null when either is unpriced |
| `runsWithWaste` | integer | runs that show at least one cause |
| `largestCause` | enum or null | the cause with the most money on it |
| `causes` | object[] | `{ cause, wasted, runs, runIds }`; `runIds` are the runs that prove it, largest waste first, at most ten |

## Causes

| Cause | Pattern | Money |
|---|---|---|
| `cache_write_never_read` | the run wrote prompt-cache tokens (`cache_write_5m` or `cache_write_1h` above zero) and read none back (`cache_read` at zero) | the run's cache-write cost by class from the rollup's per-model split |

A run whose basis is `estimated` carries one reported figure with no split by class, so it is not cited under any cause; a book that prices cache writes at nothing wasted nothing, and that run is not cited either. The findings lane's patterns (retry storms, tool-list bloat, unproductive tails) join this list when that lane costs them.
