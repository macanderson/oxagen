# get_tacho_session_policy

**Domain:** tacho
**Mode:** sync
**Scope:** workspace (all roles)
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Read the workspace model policy for Claude Code, Codex, and Stella requests routed through the loopback gateway. Returns the mode, model lists, host feature support, and the legacy recorded dollar ceiling. Every member can read the policy.

This is a different setting from `get_budget_policy`, which governs an in-app assistant **turn**. This one governs a wrapped harness **session** on somebody's laptop, and a different enforcer applies it: the daemon's loopback model proxy, from the signed policy bundle.

## Input

None.

## Output

| Field | Type | Notes |
|---|---|---|
| `mode` | `"observed" \| "enforced"` | `observed` omits workspace model rules from bundles. `enforced` arms them on hosts advertising `models_independent`. Agent budgets are independent. |
| `sessionLimitUsd` | `number \| null` | Legacy recorded ceiling; does not arm enforcement. Agent mandates supply enforced run budgets. |
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

A workspace with no row reads as observed. [ADR-149](../adr/ADR-149-independent-model-policy.md) makes model enforcement independent of agent budgets. Compatible hosts receive the policy on their next signed-bundle refresh. Host support counts indicate capability, not confirmed receipt. Older hosts need an upgrade. Cursor model traffic is outside this gateway.
