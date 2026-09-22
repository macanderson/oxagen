# update_tacho_session_policy

**Domain:** tacho
**Mode:** sync
**Scope:** workspace (Owner, Admin only)
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Set the workspace's policy for wrapped-harness sessions — the Claude Code and Codex sessions that route their model calls through the loopback gateway. Partial update: an omitted field does not change. Sets the per-session dollar ceiling and the model allow and deny lists.

**Nothing reads this policy yet.** `unsignedBundle` signs no `models` clause, and a session's ceiling comes from the agent's own mandate budget (`deriveBundleBudget`, #3710), so the gateway refuses nothing whatever is saved here. The capability records the decision and reports how far it would reach; `docs/audits/2026-09-21-model-gateway-arming.md` has why the clause waits.

## Input

All fields are optional; provide only what you want to change.

| Field | Type | Notes |
|---|---|---|
| `mode` | `"observed"?` | `observed` = meter only, and the only value accepted. Omit = no change. |
| `sessionLimitUsd` | `number \| null?` (>0 when set) | Per-session ceiling in USD. Omit = no change; `null` = clear it. |
| `modelAllow` | `string[] \| null?` (≤256) | The only models a wrapped harness may call. Omit = no change; `null` = drop the allowlist and permit every model; `[]` = permit none. |
| `modelDeny` | `string[]?` (≤256) | Models refused whatever the allowlist says. Omit = no change; `[]` = refuse none. |

### Model patterns

An entry is a model id, optionally ending in `*` to match by prefix: `claude-opus-*` covers every dated build. Case is ignored. A deny beats an allow.

### Enforced is refused

`mode: "enforced"` is refused, with every clause filled in or none. There is no enforcer to name: no bundle carries the model lists, and `budget.mode` is set from the agent's mandate. A word in the record that nothing answers for is the defect this capability exists to fix, wearing a switch. The database carries the weaker rule as well (`tacho_session_policy_enforced_check`, enforced with no clause), so both are refused.

An allowlist that is present and empty is still a decision — permit no model — and is stored apart from `null`, which is no allowlist at all.

## Output

The merged policy, plus how far it reaches.

| Field | Type | Notes |
|---|---|---|
| `mode` | `"observed" \| "enforced"` | `enforced` only for a row written before it was refused. |
| `sessionLimitUsd` | `number \| null` | |
| `modelAllow` | `string[] \| null` | |
| `modelDeny` | `string[]` | |
| `reach.hosts` | `number` | Enrolled, non-revoked hosts in this workspace. |
| `reach.hostsEnforcingModels` | `number` | Of those, the ones that advertised they could parse a `models` bundle field. None is sent one, so this is what the count will mean, not what it means today. |

`reach` is part of the answer, not a nicety. Today it reaches nothing: the control plane signs no `models` clause into any bundle, so every enrolled host keeps calling whatever model it likes. Even once the clause is emitted, `models` rides a gated bundle field — the host's bundle schema is `.strict()`, so a daemon built before the field would reject the whole mandate and is never sent one. A saved allowlist can be a correct record of a decision and still govern no machine, and a surface that showed only the saved value would report that as success.

## Roles

Owner and Admin only, at org or workspace level.

## Side effects

- Postgres: upserts `workspace.tacho_session_policy` for the workspace.
- No bundle changes. The policy is not read by `unsignedBundle`, so no etag moves and no host refetches.

## Surfaces

- `PATCH /api/v1/tacho/session-policy`
- MCP tool `update_tacho_session_policy`
- App: Spend › Budgets

## Notes

- The ceiling is checked when a call is admitted, not mid-stream, so a session can end one call past its limit.
- A model the proxy cannot read from the request is forwarded. An unreadable body is not evidence of a forbidden model, and refusing on one would take out every non-JSON call the proxy passes through untouched.
- Cursor and Stella sessions are unaffected: neither is routed through the proxy today. `docs/audits/2026-09-21-model-gateway-arming.md` §1 and §6 have the reason and what routing them would take.
