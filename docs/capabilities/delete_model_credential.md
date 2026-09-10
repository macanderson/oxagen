# delete_model_credential

**Domain:** org
**Mode:** sync
**Scope:** organisation (`scoped: false` — requires an orgId, no workspace)
**Surfaces:** api, mcp
**Sensitivity:** high · **Default effect:** deny · **Roles:** org Owner, Admin
**Billing gate:** none · **Agent tool:** no (the in-app agent must never move its own turns onto the platform key)

Contract: `packages/oxagen/src/contracts/org.model_credential.delete.ts`
Handler: `packages/handlers/src/org.model_credential.delete.ts`
API: `DELETE /v1/:org/:workspace/org/model-credential`
MCP: `apps/mcp/src/tools/org.model_credential.delete.ts`
Decision record: [ADR-053](../adr/ADR-053-in-app-agent-on-stella-serve-and-funding-sources.md)

## Intent

Remove the organisation's stored model-vendor key and return it to the
**platform** funding source. From the next turn on, the in-app agent's
completions run on Oxagen's key, and their tokens are billed as assistant
usage under the ledger reason `consume_assistant_tokens`, capped by the
organisation's monthly assistant spend cap (`assistant_spend_cap_cents`,
default 2000 credit cents, which is $20; `null` means no cap). While a key was
stored those tokens were reported and not billed (ADR-053 §3).

Idempotent: deleting when nothing is stored is not an error, because the state
the caller asked for is the state they have.

## Input

None. The credential is the caller's organisation's.

## Output

The same **redacted** view `get_model_credential` returns. After a delete it
reads `configured: false` with `provider`, `status`, `keyHint`,
`lastVerifiedAt` and `rotatedAt` all `null`, which is also the answer the
funding-source resolver gives for the platform source.

## Side effects

1. **Soft-delete the live `org.model_credentials` row** by stamping
   `deleted_at`. The ciphertext row stays as history, so the audit trail keeps
   that a key existed and when it went, but it no longer matches the
   partial unique index on live rows, so a new key can be stored at once.
2. **Invalidate** the model-credential resolver for this organisation and drop
   the provider client built on the old key, so the platform key is live for
   the next turn rather than after a cache TTL.
3. **Audit** a `model_credential.revoked` security event, **only when a key
   was actually removed**. A delete against an organisation with no stored key
   changes nothing and writes no event, so the security log records revocations
   and not no-ops. The event names the provider and the actor; the key never
   appears in it.

## Errors

- Only the kernel's own gates: a caller who is not an org Owner or Admin is
  denied, and the denial is audited like any other. A missing key is not an
  error.

## Not in this slice

Disabling a key without removing it. `status: "disabled"` exists on the row
for an operator-side hold, but none of the four capabilities takes it as
input; today the two states an operator can reach are "stored and active" and
"gone". This call does not purge the soft-deleted ciphertext.
