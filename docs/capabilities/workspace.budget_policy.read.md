# workspace.budget.policy.read

**Domain:** workspace
**Mode:** sync
**Scope:** workspace (all roles)
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Read the workspace's governed **per-turn dollar budget** — whether the workspace enforces a budget on each agent turn, the limit in USD, the enforcement mode (grace/prompt/enforce), the grace cushion, and whether it is a soft default (seeds members) or a hard ceiling (members cannot exceed it). Readable by all workspace members so the composer can surface an enforced ceiling.

## Input

None (`{}`).

## Output

| Field | Type | Notes |
|---|---|---|
| `enabled` | `boolean` | Whether a governed budget is active for this workspace (false ⇒ no governance, members keep their personal budget). |
| `limitUsd` | `number \| null` | Governed ceiling/default in USD; `null` when no amount is set. |
| `mode` | `"grace" \| "prompt" \| "enforce"` | What happens at the ceiling (see below). |
| `graceOveragePct` | `number` | `grace` mode: fraction ABOVE the limit allowed before a hard stop (`0.25` = 25%). |
| `enforcement` | `"ceiling" \| "default"` | `ceiling` = hard cap members cannot exceed; `default` = seed members can override. |

### Enforcement modes

| Mode | Label | Behaviour at the ceiling |
|---|---|---|
| `grace` | Allow overage (grace window) | Soft cap — keep going past the limit up to the grace cushion, then stop automatically. |
| `prompt` | Ask to continue | Gated cap — pause at the limit and ask for approval before spending more. |
| `enforce` | Hard stop | Hard cap — halt the turn the instant the limit is crossed. |

### Enforcement policy

| Policy | Label | Behaviour |
|---|---|---|
| `ceiling` | Hard cap | Members cannot exceed the limit; workspace-level enforcement mode can only get stricter (not more lenient), overriding member budgets. |
| `default` | Seed default | Workspace budget seeds members who haven't set their own; members with a personal budget can override the workspace setting if theirs is stricter. |

## Roles

All roles (Owner, Admin, Member, Viewer), org and workspace level. Readable by all members.

## Surfaces

- `GET /api/v1/workspace/budget-policy`
- MCP tool `workspace_budget_policy_read`
- Agent: no approval required, risk `low`.

## Notes

- Enforcement is applied in the shared agent turn loop (`runCodingAgent`), so the same budget behaves identically in the API and the web app.
- When `enabled=false`, members' personal budgets remain in effect. When `enabled=true`, the workspace budget is merged with each member's personal budget via `resolveEffectiveTurnBudget` (@oxagen/billing).
- The saved value is a **default**; a surface may override the budget per turn at submit time.
