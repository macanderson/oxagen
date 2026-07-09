# budget.policy.write

**Domain:** user
**Mode:** sync
**Scope:** user (all roles)
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Update the calling user's saved **per-turn dollar budget** (partial update — only provided fields change). Turn the per-turn ceiling on/off, set the limit in USD, choose the enforcement mode, and set the grace cushion.

## Input

All fields are optional; provide only what you want to change.

| Field | Type | Notes |
|---|---|---|
| `enabled` | `boolean?` | Turn the per-turn budget on or off. Omit = no change. |
| `limitUsd` | `number \| null?` | Per-turn ceiling in USD (`> 0` when set). Omit = no change; `null` = clear the limit; number = set. |
| `mode` | `"grace" \| "prompt" \| "enforce"?` | Enforcement at the ceiling. Omit = no change. |
| `graceOveragePct` | `number?` (0–10) | `grace` cushion as a fraction ABOVE the limit (`0.25` = allow 25% overage). |

### Enforcement modes

| Mode | Label | Behaviour at the ceiling |
|---|---|---|
| `grace` | Allow overage (grace window) | Keep going past the limit up to the grace cushion, then stop automatically. |
| `prompt` | Ask to continue | Pause at the limit and ask for approval before spending more. |
| `enforce` | Hard stop | Halt the turn the instant the limit is crossed and fail with a budget-exceeded reason. |

## Output

Returns the full, merged budget state after the update (same shape as `budget.policy.read`).

| Field | Type |
|---|---|
| `enabled` | `boolean` |
| `limitUsd` | `number \| null` |
| `mode` | `"grace" \| "prompt" \| "enforce"` |
| `graceOveragePct` | `number` |

## Roles

All roles (Owner, Admin, Member, Viewer), org and workspace level. Users update only their own budget.

## Side effects

- Postgres: upserts the per-turn budget columns on `auth.user_preferences` for the calling user.

## Surfaces

- `PATCH /api/v1/user/budget/write`
- MCP tool `budget_policy_write`
- Agent: no approval required, risk `low`.
