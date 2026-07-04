# agent.memory.policy.write

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Update the workspace memory decay policy: the confidence half-lives by memory weight and the recall confidence threshold. All fields are optional (partial update); omitted fields keep their current value. Returns the full policy after the update.

## Input

| Field | Type | Notes |
|---|---|---|
| `halfLifeLowDays?` | `int > 0` | Decay half-life (days) for OBSERVATION memories. |
| `halfLifeHighDays?` | `int > 0` | Decay half-life (days) for RULE memories. |
| `recallThreshold?` | `number 0–1` | Memories below this confidence fraction are excluded from recall. |
| `complianceThreshold?` | `int 1–100` | Enforcement at or above which a rule deviation counts as a VIOLATION (else DISCRETION). |
| `defaultDecayFloor?` | `number 0–100` | Confidence never auto-decays below this floor. |

## Output

| Field | Type | Notes |
|---|---|---|
| `halfLifeLowDays` | `int > 0` | Decay half-life (days) for OBSERVATION memories. |
| `halfLifeHighDays` | `int > 0` | Decay half-life (days) for RULE memories. |
| `recallThreshold` | `number 0–1` | Recall confidence threshold. |
| `complianceThreshold` | `int 1–100` | Rule-violation enforcement threshold. |
| `defaultDecayFloor` | `number 0–100` | Confidence decay floor. |

## Roles

Org Owner, Org Admin, Workspace Owner.

## Side effects

- Postgres: persists the updated workspace memory decay policy.

## Errors

| code | meaning |
|---|---|
| `validation_error` | A supplied value fell outside its allowed range. |
| `unauthorized` | Caller lacks the required org/workspace role. |
