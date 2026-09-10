# get_model_credential

**Domain:** org
**Mode:** sync
**Scope:** organisation (`scoped: false` — requires an orgId, no workspace)
**Surfaces:** api, mcp
**Sensitivity:** high · **Default effect:** deny · **Roles:** org Owner, Admin
**Risk level:** low · **Requires approval:** no · **Billing gate:** none

Contract: `packages/oxagen/src/contracts/org.model_credential.get.ts`
Handler: `packages/handlers/src/org.model_credential.get.ts`
API: `GET /v1/:org/:workspace/org/model-credential`
MCP: `apps/mcp/src/tools/org.model_credential.get.ts`
Decision record: [ADR-053](../adr/ADR-053-in-app-agent-on-stella-serve-and-funding-sources.md)

## Intent

Answer "is a customer key stored for this organisation, and which one?" This is
what the settings page (Organisation settings → Model funding) renders, and
what tells an operator which funding source the in-app agent is on:

- **A key is stored** (`configured: true`): completions run on the customer's
  key. Tokens are reported and not billed. Under an `openrouter` key,
  embeddings are the exception: OpenRouter does not serve them, so they stay
  on the platform key and are billed.
- **No key is stored** (`configured: false`): the platform key pays the vendor.
  Tokens are billed as `consume_assistant_tokens` under the organisation's
  monthly assistant spend cap (`assistant_spend_cap_cents`, default 2000
  credit cents, which is $20; `null` means no cap).

Absence of a row is a real answer, never a 404: it means the platform source.

## Input

None. The credential is the caller's organisation's.

## Output

| Field | Type | Notes |
| --- | --- | --- |
| configured | boolean | Whether a key is stored |
| provider | `"openrouter" \| "gateway"` \| null | Which vendor issued it; `null` when none |
| status | `"active" \| "disabled"` \| null | Only `active` is used for completions |
| keyHint | string \| null | The **last four characters** of the key, what a vendor dashboard shows |
| lastVerifiedAt | ISO-8601 \| null | Last successful `verify_model_credential` |
| rotatedAt | ISO-8601 \| null | Last time the key was set or replaced |

**The key is never returned.** A read that echoed it would turn every
Owner/Admin token into a copy of the customer's vendor credential, so there is
deliberately no read-back path. An operator who needs to change the key calls
`set_model_credential` with a new one.

The view is the same shape the funding-source resolver in `@oxagen/ai` reads,
so the settings page and the runtime cannot disagree about which source is
live.

## Side effects

None. Reads the organisation's live `org.model_credentials` row through
`withTenantDb`, so RLS is the filter (unlike a data-plane binding, nothing
resolves *through* this table, so it needs no system read). The envelope is
not opened: every field returned is a column stored beside the ciphertext in
the clear, including the `key_hint` column, so a read never touches the KMS
key.

## Errors

- Only the kernel's own gates: a caller who is not an org Owner or Admin is
  denied, and the denial is audited like any other.

## Not in this slice

A verification result. `lastVerifiedAt` says when the key last passed; it does
not say whether it would pass now. Call `verify_model_credential` with no input
for that.
