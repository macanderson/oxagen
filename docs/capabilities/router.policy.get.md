# router.policy.get

**Capability name:** `get_routing_policy`
**Domain:** router
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

## Intent

Read the **effective** Verified-Outcome Market Router policy for the current
org/workspace scope, together with its provenance. The market router turns model
selection into a learned, economic decision; this returns the tunables in force
plus which scope supplied them (the workspace's own row, the org-level default,
or the built-in OFF default). Read-only — no AI tokens spent.

## Input

| Field | Type | Notes                                            |
| ----- | ---- | ------------------------------------------------ |
| —     | —    | No input fields; the active scope selects the row |

## Output

| Field                 | Type                                | Notes                                                        |
| --------------------- | ----------------------------------- | ------------------------------------------------------------ |
| `mode`                | `"off" \| "shadow" \| "enforce"`    | `off` = deterministic routing; `shadow` = learn; `enforce` = act |
| `successThreshold`    | `number`                            | Min observed verified-success rate (0..1) a model must clear |
| `minSamples`          | `integer`                           | Min samples before a model's verified rate is trusted        |
| `windowDays`          | `integer`                           | Trailing window the stats are computed over                  |
| `escalateOnRejection` | `boolean`                           | Escalate one tier when the judge rejects a revision round    |
| `source`              | `"workspace" \| "org" \| "default"` | Which scope supplied the effective policy                    |

## Side effects

None. Reads `workspace.routing_policy` (org-default + workspace rows) and resolves
them (workspace > org > OFF).
