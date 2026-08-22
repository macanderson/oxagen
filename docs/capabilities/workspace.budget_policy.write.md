# workspace.budget.policy.write

**Domain:** workspace
**Mode:** sync
**Scope:** workspace (Owner, Admin only)
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Set the workspace's governed **per-turn dollar budget** (partial update — only provided fields change). An org/workspace admin can dictate a budget for a workspace: turn it on/off, set the USD limit, choose the enforcement mode (grace = allow overage within a grace window then stop; prompt = ask to continue; enforce = hard stop), the grace cushion, and whether it is a soft `default` (seeds members who haven't set their own) or a hard `ceiling` (clamps members — they cannot exceed it and the mode can only get stricter). Owner/Admin only.

## Input

All fields are optional; provide only what you want to change.

| Field | Type | Notes |
|---|---|---|
| `enabled` | `boolean?` | Turn workspace budget governance on or off. Omit = no change. |
| `limitUsd` | `number \| null?` (>0 when set) | Workspace per-turn ceiling in USD. Omit = no change; `null` = clear the limit; number = set. |
| `mode` | `"grace" \| "prompt" \| "enforce"?` | Enforcement at the ceiling. Omit = no change. |
| `graceOveragePct` | `number?` (0–10) | `grace` cushion as a fraction ABOVE the limit (`0.25` = allow 25% overage). |
| `enforcement` | `"ceiling" \| "default"?` | Hard enforcement: `ceiling` = hard cap members cannot exceed; `default` = seed members can override. |

### Enforcement modes

| Mode | Label | Behaviour at the ceiling |
|---|---|---|
| `grace` | Allow overage (grace window) | Keep going past the limit up to the grace cushion, then stop automatically. |
| `prompt` | Ask to continue | Pause at the limit and ask for approval before spending more. |
| `enforce` | Hard stop | Halt the turn the instant the limit is crossed and fail with a budget-exceeded reason. |

### Enforcement policy

| Policy | Label | Behaviour |
|---|---|---|
| `ceiling` | Hard cap | Members cannot exceed the limit; this workspace mode can only get stricter (not more lenient), overriding personal budgets. |
| `default` | Seed default | Seeds members who haven't set their own budget; members with a personal budget can override if theirs is stricter. |

## Output

Returns the full, merged budget state after the update (same shape as `workspace.budget.policy.read`).

| Field | Type |
|---|---|
| `enabled` | `boolean` |
| `limitUsd` | `number \| null` |
| `mode` | `"grace" \| "prompt" \| "enforce"` |
| `graceOveragePct` | `number` |
| `enforcement` | `"ceiling" \| "default"` |

## Roles

Owner and Admin only, workspace level. Users update the workspace's shared policy.

## Side effects

- Postgres: upserts the per-turn budget columns on `workspace_budget_policy` for the workspace.

## Surfaces

- `PATCH /api/v1/workspace/budget-policy`
- MCP tool `workspace_budget_policy_write`
- Agent: no approval required, risk `medium`.

## Notes

- When `enforcement="ceiling"`, members' personal budgets are overridden by the workspace ceiling. When `enforcement="default"`, members with a stricter personal budget take precedence.
- Enforcement is applied in the shared agent turn loop (`runCodingAgent`), so the same budget behaves identically in the API and the web app.
