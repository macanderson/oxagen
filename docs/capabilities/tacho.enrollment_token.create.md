# create_enrollment_token

Mint the single-use enrollment token a machine presents to `enroll_host` to become a registered agent's host (MC spec §7.2 "a one-time enrollment token embedded"; mockup `REG_TOKEN` "expires in 30 min · single use"; #2967). The token names the agent the host will report as, is shown to the operator exactly once, is stored as its SHA-256 digest (`tacho.enrollment_tokens.token_hash`), and is consumed the first time it is presented. Issuing a token writes nothing to the agent; a token that expires unused is replaced by issuing another.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/tacho/enrollment-tokens` → 201
- CLI: printed by the register flow as `oxagen agent enroll --token …`
- No MCP tool and no agent surface: a credential mint is never reachable by a model
- Authentication: session; org Owner or Admin, checked by the handler (INV-29), the same gate `create_tacho_enrollment` keeps
- Capability name: `create_enrollment_token`
- Not billed (`noBillingGate: true`); IAM default-deny; high sensitivity

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `agentId` | string | yes | `agt_…`, an agent in this workspace that is neither deleted nor retired |
| `ttlMinutes` | integer | no | 1-60, default 30 |

## Output

| Field | Type | Description |
|---|---|---|
| `tokenId` | string | `tet_…` |
| `token` | string | `oxe_1time_` + 26 Crockford characters; shown once, never recoverable |
| `expiresAt` | string | RFC 3339 |
| `agentId` | string | `agt_…` |
| `agentKey` | string | `org_ns.ws_ns.slug` (ADR-024): the key the enrolled host reports as |
| `enrollCommand` | string | `oxagen agent enroll --token <token>`, plus `--harness <harness>` when the agent runs under a hook-based harness (`claude-code`, `codex`, `cursor`, `stella`) |

## Refusals

`forbidden: no_principal` / `org_role_required`; `not_found: agent_not_found`; `conflict: agent_retired` (the agent is retired, so no machine can enroll as it, and the handler writes no token).

## Honesty

The token is the only secret this capability produces and it leaves the server once, in this response. The row keeps the digest, who it was issued to, when it expires, when and by which host it was used, and how many presentations were refused (`rejected_count`), which the installer's "token rejected" screen reads.
