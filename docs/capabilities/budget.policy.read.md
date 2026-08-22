# budget.policy.read

**Domain:** user
**Mode:** sync
**Scope:** user (all roles)
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Read the calling user's saved **per-turn dollar budget** — the default ceiling applied to a single agent turn. A turn budget is OFF by default; when enabled it caps how much a turn may spend and one of three enforcement modes decides what happens at the ceiling.

## Input

None (`{}`).

## Output

| Field | Type | Notes |
|---|---|---|
| `enabled` | `boolean` | When false, turns run with no dollar ceiling (the default). |
| `limitUsd` | `number \| null` | Per-turn ceiling in USD; `null` when no limit is set. |
| `mode` | `"grace" \| "prompt" \| "enforce"` | What happens at the ceiling (see below). |
| `graceOveragePct` | `number` | `grace` mode: fraction ABOVE the limit allowed before a hard stop (`0.25` = 25%). |

### Enforcement modes

| Mode | Label | Behaviour at the ceiling |
|---|---|---|
| `grace` | Allow overage (grace window) | Soft cap — keep going past the limit up to the grace cushion, then stop automatically. |
| `prompt` | Ask to continue | Gated cap — pause at the limit and ask for approval before spending more. |
| `enforce` | Hard stop | Hard cap — halt the turn the instant the limit is crossed. |

## Roles

All roles (Owner, Admin, Member, Viewer), org and workspace level. Users read only their own budget.

## Surfaces

- `GET /api/v1/user/budget/read`
- MCP tool `budget_policy_read`
- Agent: no approval required, risk `low`.

## Notes

- Enforcement is applied in the shared agent turn loop (`runCodingAgent`), so the same budget behaves identically in the API and the web app.
- The saved value is a **default**; a surface may override the budget per turn at submit time.
