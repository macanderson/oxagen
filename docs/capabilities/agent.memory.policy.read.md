# agent.memory.policy.read

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Read the workspace memory decay policy: the confidence half-lives by memory weight and the recall confidence threshold. These knobs govern how `AgentMemory` confidence auto-decays over time and which memories are excluded from recall.

## Input

No input fields.

## Output

| Field | Type | Notes |
|---|---|---|
| `halfLifeLowDays` | `int > 0` | Decay half-life (days) for OBSERVATION memories. Default `30`. |
| `halfLifeHighDays` | `int > 0` | Decay half-life (days) for RULE memories. Default `90`. |
| `recallThreshold` | `number 0–1` | Memories below this confidence fraction are excluded from recall. Default `0.1`. |
| `complianceThreshold` | `int 1–100` | Enforcement at or above which a rule deviation counts as a VIOLATION (else DISCRETION). Default `70`. |
| `defaultDecayFloor` | `number 0–100` | Confidence never auto-decays below this floor. Default `5`. |

## Roles

Org Owner, Org Admin, Workspace Owner, Workspace Member.

## Side effects

- None. Read-only projection of the workspace memory policy.

## Errors

| code | meaning |
|---|---|
| `unauthorized` | Caller lacks the required org/workspace role. |
