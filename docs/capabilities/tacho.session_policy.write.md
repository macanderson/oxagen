# update_tacho_session_policy

**Domain:** tacho
**Mode:** sync
**Scope:** workspace (Owner, Admin only)
**Surfaces:** api, mcp, agent
**Risk level:** high
**Agent approval:** required

## Intent

Enable or disable workspace model allow and deny lists for calls routed through upgraded hosts. [ADR-149](../adr/ADR-149-independent-model-policy.md) separates the workspace's model decision from the agent's run budget.

## Input

All fields are optional. Omitted fields keep their values.

| Field | Meaning |
| --- | --- |
| `mode` | `observed` disables model lists. `enforced` enables them and requires an allow or deny list. |
| `sessionLimitUsd` | Legacy recorded workspace ceiling, positive USD or null. It does not enforce a run budget. Set that budget on the agent mandate. |
| `modelAllow` | Up to 256 patterns. Null removes the allowlist. An empty array permits no model. |
| `modelDeny` | Up to 256 patterns. A matching deny takes precedence. An empty array denies nothing. |

Patterns match model ids case-insensitively. A trailing `*` matches a prefix. No other wildcard is supported.

## Output

The saved policy and `reach: { hosts, hostsEnforcingModels }`. The second count identifies non-revoked hosts advertising `models_independent`. It measures support, not receipt. Enabled lists apply after the host's next signed-mandate refresh. Upgrade other hosts before relying on this control there.

## Roles

The handler checks Owner or Admin at organization or workspace scope. Agent calls require approval.

## Side effects

The write updates `workspace.tacho_session_policy`. Enabled lists change the signed bundle content and etag for upgraded hosts. Disabling removes the clause. An agent budget alone does not add it.

## Surfaces

- `PATCH /api/v1/tacho/session-policy`
- MCP tool `update_tacho_session_policy`
- Spend, Budgets, Gateway models

## Limits

This governs routed Claude Code, Codex, and Stella Anthropic model calls. Cursor and Stella's other providers remain outside this route. A laptop owner can bypass the configured proxy. Armed lists refuse unreadable or ambiguous model requests on metered endpoints before forwarding. The legacy workspace ceiling remains recorded only.
