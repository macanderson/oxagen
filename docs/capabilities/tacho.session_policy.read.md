# get_tacho_session_policy

**Domain:** tacho
**Mode:** sync
**Scope:** workspace (all roles)
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Read the workspace's policy for wrapped-harness sessions — the Claude Code and Codex sessions that route their model calls through the loopback gateway. Returns the mode, the per-session dollar ceiling, and the model allow and deny lists. Every member can read it, so a person can see what their own machine will refuse before it refuses.

This is a different setting from `get_budget_policy`, which governs an in-app assistant **turn**. This one governs a wrapped harness **session** on somebody's laptop, and a different enforcer applies it: the daemon's loopback model proxy, from the signed policy bundle.

## Input

None.

## Output

| Field | Type | Notes |
|---|---|---|
| `mode` | `"observed" \| "enforced"` | `observed` = the gateway meters and refuses nothing. `enforced` = it refuses a call that breaks a clause below. |
| `sessionLimitUsd` | `number \| null` | The per-session ceiling in USD; `null` when no ceiling is set. |
| `modelAllow` | `string[] \| null` | The only models a wrapped harness may call. `null` = no allowlist, so every model is permitted. `[]` = an allowlist that permits nothing. |
| `modelDeny` | `string[]` | Models refused whatever the allowlist says. A deny beats an allow. |

### Model patterns

An entry is a model id, optionally ending in `*` to match by prefix: `claude-opus-*` covers every dated build. Case is ignored. No other wildcard is honoured — the host applies this rule with no glob library, because `@oxagen/tacho` is a leaf package with no `@oxagen/*` runtime dependency.

## Roles

Every org and workspace role, including Viewer. A person whose session is about to be refused should be able to read the reason.

## Side effects

None. `noBillingGate: true`.

## Surfaces

- `GET /api/v1/tacho/session-policy`
- MCP tool `get_tacho_session_policy`
- App: Spend › Budgets

## Notes

- A workspace with no row reads as observed-only, which is what every host had before the setting existed.
- `mode` governs both enforced clauses. One word answers "does this host refuse anything", rather than two clauses that can disagree.
- The ceiling is checked when a call is admitted, not mid-stream, so a session can end one call past its limit. Cutting a response in half to save its last tokens would cost the operator the whole call.
