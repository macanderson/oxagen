# router.decision.preview

**Capability name:** `preview_routing_decision`
**Domain:** router
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

A **dry run**: given a prompt (and optional structural signals + policy
overrides), derive the task class, read the observed stats, and return the full
market decision — which model it **would** pick, why, and the ranked candidates
it beat — **without running anything or changing state**. The inspector for "what
would the router do?".

## Input

| Field                 | Type                 | Notes                                                     |
| --------------------- | -------------------- | --------------------------------------------------------- |
| `prompt`              | `string`             | The prompt to route (required)                            |
| `fileCount`           | `integer` (optional) | Expected files touched — feeds breadth bucketing/fallback |
| `crossPackage`        | `boolean` (optional) | Whether the task crosses package boundaries               |
| `taskClass`           | `string` (optional)  | Override the derived task class                           |
| `mode`                | `"off"\|"shadow"\|"enforce"` (optional) | Policy override for this preview        |
| `successThreshold`    | `number` (optional)  | Threshold override                                        |
| `minSamples`          | `integer` (optional) | Min-samples override                                      |
| `windowDays`          | `integer` (optional) | Window override                                           |
| `escalateOnRejection` | `boolean` (optional) | Escalation override                                       |

## Output

| Field            | Type                                        | Notes                                                 |
| ---------------- | ------------------------------------------- | ----------------------------------------------------- |
| `tier`           | `string`                                    | Chosen tier (fast/balanced/precise)                   |
| `model`          | `string`                                    | Chosen gateway slug                                   |
| `rationale`      | `string`                                    | Human-readable reason                                 |
| `source`         | `"market" \| "deterministic-fallback"`      | Whether a real market clearing or the fallback        |
| `taskClass`      | `string`                                    | The derived (or overridden) task class                |
| `candidates`     | `array`                                     | Ranked audit trail: `model, verifiedRate, samples, avgCostUsdMicros, eligible, reason` |
| `policySnapshot` | `object`                                    | The effective policy (+ overrides) the decision used  |

## Side effects

None. Reads `router_outcomes`; changes nothing.
