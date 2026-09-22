# update_tacho_session_policy

**Domain:** tacho
**Mode:** sync
**Scope:** workspace (Owner, Admin only)
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Set the workspace's policy for wrapped-harness sessions — the Claude Code and Codex sessions that route their model calls through the loopback gateway. Partial update: an omitted field does not change. Choose the mode, the per-session dollar ceiling, and the model allow and deny lists.

Before this capability the bundle carried `budget.mode: "observed"` as a literal, so the proxy's refusal branches were real code that nothing in production could reach — the gateway metered every call and governed none (`docs/audits/2026-09-21-model-gateway-arming.md` §2).

## Input

All fields are optional; provide only what you want to change.

| Field | Type | Notes |
|---|---|---|
| `mode` | `"observed" \| "enforced"?` | `observed` = meter only. `enforced` = refuse on the clauses below. Omit = no change. |
| `sessionLimitUsd` | `number \| null?` (>0 when set) | Per-session ceiling in USD. Omit = no change; `null` = clear it. |
| `modelAllow` | `string[] \| null?` (≤256) | The only models a wrapped harness may call. Omit = no change; `null` = drop the allowlist and permit every model; `[]` = permit none. |
| `modelDeny` | `string[]?` (≤256) | Models refused whatever the allowlist says. Omit = no change; `[]` = refuse none. |

### Model patterns

An entry is a model id, optionally ending in `*` to match by prefix: `claude-opus-*` covers every dated build. Case is ignored. A deny beats an allow.

### Enforced needs something to enforce

`mode: "enforced"` is refused unless the merged policy carries at least one clause — a ceiling, an allowlist, or a deny list. A setting that says it governs and governs nothing is the defect this capability exists to fix, wearing a switch. The database rejects it too (`tacho_session_policy_enforced_check`); the handler refuses first so a person is told what to set rather than a constraint name.

An allowlist that is present and empty **is** a clause: refusing every model is a decision an operator can make.

## Output

The merged policy, plus how far it reaches.

| Field | Type | Notes |
|---|---|---|
| `mode` | `"observed" \| "enforced"` | |
| `sessionLimitUsd` | `number \| null` | |
| `modelAllow` | `string[] \| null` | |
| `modelDeny` | `string[]` | |
| `reach.hosts` | `number` | Enrolled, non-revoked hosts in this workspace. |
| `reach.hostsEnforcingModels` | `number` | Of those, the ones that advertised they can parse the `models` bundle field. |

`reach` is part of the answer, not a nicety. `models` rides a gated bundle field: the host's bundle schema is `.strict()`, so a daemon built before the field would reject the whole mandate, and the control plane therefore never sends it one. A saved allowlist can be a correct record of a decision and still govern no machine. A surface that showed only the saved value would report that as success.

## Roles

Owner and Admin only, at org or workspace level.

## Side effects

- Postgres: upserts `workspace.tacho_session_policy` for the workspace.
- The next policy bundle each host fetches carries the new clauses, and its etag moves, so hosts pick the change up on their next control poll rather than at session start.

## Surfaces

- `PATCH /api/v1/tacho/session-policy`
- MCP tool `update_tacho_session_policy`
- App: Spend › Budgets

## Notes

- The ceiling is checked when a call is admitted, not mid-stream, so a session can end one call past its limit.
- A model the proxy cannot read from the request is forwarded. An unreadable body is not evidence of a forbidden model, and refusing on one would take out every non-JSON call the proxy passes through untouched.
- Cursor and Stella sessions are unaffected: neither is routed through the proxy today. `docs/audits/2026-09-21-model-gateway-arming.md` §1 and §6 have the reason and what routing them would take.
