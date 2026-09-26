# get_run_cost

The Run page's cost strip and Cost tab (Mission Control spec §12.6, §12.7; ADR-060): one run's `cost.run_totals` row, rebuilt from the run's model-call and tool-call frames. For a wrapped session, `cost.run-progress` rebuilds it while the run records frames, at most two minutes behind the latest batch, and `cost.run-rollup` rebuilds it again at the seal (ADR-159). A ledger run's row is built after its seal. A row built while the run was open answers `isEstimate: true`.

## Mode

**sync**

## Surface

**Surfaces:** api, mcp, agent

- API: `POST /v1/:org_slug/:workspace_slug/runs/cost`
- MCP: `get_run_cost`
- Agent: one of the in-app assistant's seven pins, offered on every turn (`INTERACTIVE_AGENT_CAPABILITIES`). Low risk, no approval.
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
| `baseline` | object or null | the agent's own recent runs, described below; null when the run names no agent, or the agent has fewer than 5 sealed runs in the window (#3984) |

The rollup:

| Field | Type | Description |
|---|---|---|
| `cost` | object or null | `{ micros, currency, basis }`; null when no model frame was priced |
| `tokens` | object | counts by class: `input_uncached`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `output`, `reasoning` |
| `cacheHitRate` | number or null | `cache_read ÷ (input_uncached + cache_read)`, weighted by each frame's spend; null when no frame carried input tokens. Cache writes are not in the denominator, so a run that rebuilt its cache can still read a high rate. The rebuild share, `(cache_write_5m + cache_write_1h) ÷ (input_uncached + cache_read + cache_write_5m + cache_write_1h)`, comes from `tokens`, and the Run page's Cost tab prints it beside the rate |
| `turns` | integer or null | null for a ledger run whose model-call payloads are encrypted |
| `steps`, `modelCalls`, `toolCalls` | integer | counts from the frames |
| `retries` | integer or null | the harness's API retry count; null for a ledger run |
| `productiveRatio` | number or null | `advancedSteps ÷ steps`; null while the steps are not graded |
| `advancedSteps`, `unproductiveSteps` | integer or null | the steps that moved the run forward and the steps that did not (#3984). Null together on a row rolled up before grading existed, until its next rollup, and on a run with no steps. When set, they sum to `steps` |
| `unproductiveCauses` | object or null | `{ failed, repeated, retried }`: why the unproductive steps made no progress. The three sum to `unproductiveSteps`, and the object is null exactly when the counts are |
| `byModel` | object[] | `{ model, provider, calls, cost, tokens, costByClass, cacheSaving, hasUnpriced }`, one per model the frames used; each `cost` carries its own basis, or is null when none of the model's frames was priced. The per-model fields are described below |
| `byTool` | object[] | `{ name, calls, resultTokens, cost }`. `resultTokens` is the tool-result tokens the OTel tool spans recorded for the tool's calls, summed, or null when no call recorded them. `cost` prices them at the run's uncached input rate, the rule the findings job uses. Its basis is always `estimated`, and it attributes input the run's `cost` already counts, so it never adds to it. It is null when `resultTokens` is null or the run has no input price (#3892) |
| `priceEntryIds` | string[] | the `cost.price_entries` rows the frames were priced with (spec §12.2) |
| `rolledUpAt` | string | RFC 3339; when the row was last rebuilt |
| `isEstimate` | boolean | true when the row was rebuilt while the run was open: every figure covers the frames recorded so far, and the run may add more. False once the rollup has rebuilt the sealed run |

Each `byModel` entry:

| Field | Type | Description |
|---|---|---|
| `cost` | object or null | the model's recorded cost, `{ micros, currency, basis }`; null when none of its frames was priced |
| `tokens` | object | the model's counts by class |
| `costByClass` | object or null | `cost` split by the six classes in `tokens`, each `{ micros, currency, basis }`. Every class is priced from the price book at its frame's instant and rounded once. A class no entry priced is a zero figure. An estimated frame's own reported figure has no split, so it sits under `output`. Null exactly when `cost` is |
| `cacheSaving` | object or null | what the model's cache reads saved: each frame's `cache_read` tokens priced at the `input_uncached` rate less the `cache_read` rate, both at the frame's instant. A zero figure when no frame read the cache. Null when a frame that read the cache had no price for either class, when none of the model's frames was priced, and on a row rolled up before the saving was recorded, until the run's next rollup |
| `hasUnpriced` | boolean | true when any call to the model went unpriced, including a model where another call did price and `cost` is therefore not null |

These are the recorded figures. A reader shows them as they are and does not reprice the token counts with today's price book, because a later rate change would then disagree with the run's recorded cost (#4069).

The provisional figures come from `tacho.session_models` and the root session's tool-call counter. Ingest adds each counted `llm_call` frame to them as it lands, so they cover the run up to its last recorded event. The rollup replaces them once it rebuilds the run.

| Field | Type | Description |
|---|---|---|
| `byModel` | object[] | `{ model, provider, calls, cost }`, one per model; `cost` is the sum of each call's reported cost with the row's basis, `client_attested` when the row carries none the contract knows, or null when no call reported a cost |
| `toolCalls` | integer | the root session's tool-call count |
| `asOf` | string | RFC 3339; the run's last recorded event |

Subagent sessions are not included. They are separate sessions until the rollup folds them into the run.

The baseline sets this run beside the agent's sealed runs in the 30 days before it started. This run is not in it.

| Field | Type | Description |
|---|---|---|
| `windowDays` | integer | always 30 |
| `before` | string | RFC 3339; this run's `startedAt`, the end of the window |
| `runs` | integer | the agent's sealed runs in the window, at least 1 |
| `medianCost` | object or null | the median cost of the priced runs in the window, with the fold of their bases; null when fewer than 5 of them were priced |
| `productiveRatio` | number or null | `sum(advanced_steps) ÷ sum(steps)` over the graded runs in the window; null when fewer than 5 of them were graded |

## Honesty

A run with no row answers `rollup: null` and a page renders that slice as not recorded; a row whose frames priced nothing answers `cost: null`. Neither is a zero. The read names `org_id` and `workspace_id` beside RLS, so another workspace's run answers `rollup: null` as well. A figure with `isEstimate: true` is labelled an estimate wherever it renders. The Run page labels provisional figures as provisional, because the rollup may reprice or recount them.
