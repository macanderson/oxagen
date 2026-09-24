# get_run_cost

The Run page's cost strip and Cost tab (Mission Control spec §12.6, §12.7; ADR-060): one run's `cost.run_totals` row, rebuilt from the run's model-call and tool-call frames. For a wrapped session, `cost.run-progress` rebuilds it while the run records frames, at most two minutes behind the latest batch, and `cost.run-rollup` rebuilds it again at the seal (ADR-159). A ledger run's row is built after its seal. A row built while the run was open answers `isEstimate: true`.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs/cost`
- MCP: `get_run_cost`
- Authentication: session (org Owner, Admin, Billing or Member; workspace Owner or Member)
- Capability name: `get_run_cost`
- Not billed (`noBillingGate: true`): a console read is never a governed action. IAM default-deny; medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `runId` | string | yes | `arun_…` or `tse_…` |

## Output

| Field | Type | Description |
|---|---|---|
| `runId` | string | as asked |
| `rollup` | object or null | null until the rollup has built a row for the run, or for an id with no row in the caller's workspace |
| `provisional` | object, null or absent | present only while `rollup` is null and the id names a wrapped session in the caller's workspace |

The rollup:

| Field | Type | Description |
|---|---|---|
| `cost` | object or null | `{ micros, currency, basis }`; null when no model frame was priced |
| `tokens` | object | counts by class: `input_uncached`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `output`, `reasoning` |
| `cacheHitRate` | number or null | `cache_read ÷ (input_uncached + cache_read)`, weighted by each frame's spend; null when no frame carried input tokens |
| `turns` | integer or null | null for a ledger run whose model-call payloads are encrypted |
| `steps`, `modelCalls`, `toolCalls` | integer | counts from the frames |
| `retries` | integer or null | the harness's API retry count; null for a ledger run |
| `productiveRatio` | number or null | null until the grading lane writes it |
| `byModel` | object[] | `{ model, provider, calls, cost, tokens }`, one per model the frames used; each `cost` carries its own basis, or is null when none of the model's frames was priced |
| `byTool` | object[] | `{ name, calls }` |
| `priceEntryIds` | string[] | the `cost.price_entries` rows the frames were priced with (spec §12.2) |
| `rolledUpAt` | string | RFC 3339; when the row was last rebuilt |
| `isEstimate` | boolean | true when the row was rebuilt while the run was open: every figure covers the frames recorded so far, and the run may add more. False once the rollup has rebuilt the sealed run |

The provisional figures come from `tacho.session_models` and the root session's tool-call counter. Ingest adds each counted `llm_call` frame to them as it lands, so they cover the run up to its last recorded event. The rollup replaces them once it rebuilds the run.

| Field | Type | Description |
|---|---|---|
| `byModel` | object[] | `{ model, provider, calls, cost }`, one per model; `cost` is the sum of each call's reported cost with the row's basis, `client_attested` when the row carries none the contract knows, or null when no call reported a cost |
| `toolCalls` | integer | the root session's tool-call count |
| `asOf` | string | RFC 3339; the run's last recorded event |

Subagent sessions are not included. They are separate sessions until the rollup folds them into the run.

## Honesty

A run with no row answers `rollup: null` and a page renders that slice as not recorded; a row whose frames priced nothing answers `cost: null`. Neither is a zero. The read names `org_id` and `workspace_id` beside RLS, so another workspace's run answers `rollup: null` as well. A figure with `isEstimate: true` is labelled an estimate wherever it renders. The Run page labels provisional figures as provisional, because the rollup may reprice or recount them.
