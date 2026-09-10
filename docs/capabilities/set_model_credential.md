# set_model_credential

**Domain:** org
**Mode:** sync
**Scope:** organisation (`scoped: false` — requires an orgId, no workspace)
**Surfaces:** api, mcp
**Sensitivity:** high · **Default effect:** deny · **Roles:** org Owner, Admin
**Billing gate:** none · **Agent tool:** no (the in-app agent must never set the key that funds its own turns)

Contract: `packages/oxagen/src/contracts/org.model_credential.set.ts`
Handler: `packages/handlers/src/org.model_credential.set.ts`
API: `PUT /v1/:org/:workspace/org/model-credential`
MCP: `apps/mcp/src/tools/org.model_credential.set.ts`
Decision record: [ADR-053](../adr/ADR-053-in-app-agent-on-stella-serve-and-funding-sources.md)

## Intent

Store the organisation's own model-vendor API key. While a key is stored, every
completion the in-app agent makes for the organisation runs on that key and the
customer's own vendor invoice. Oxagen reports those tokens in full and bills
nothing for them (ADR-053 §2–3).

With no key stored, the organisation is on the **platform** funding source:
Oxagen's key pays the vendor, and the tokens are billed back as assistant usage
under the ledger reason `consume_assistant_tokens`, capped by the
organisation's monthly assistant spend cap (`assistant_spend_cap_cents`,
default 2000 credit cents, which is $20; `null` means no cap).

One credential per organisation. Setting a second one replaces the first,
which is what a rotation is. `delete_model_credential` returns the
organisation to the platform key.

The credential is on the **organisation**, never the workspace: the key pays
for every workspace's assistant turns, and the vendor invoice is the
organisation's.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| provider | `"openrouter" \| "gateway"` | Which vendor issued the key |
| apiKey | string (8–512 chars) | The plaintext key, as pasted |

Two providers today, because each reaches every model in the catalog through
one key, so one credential makes the whole tier table work:

| provider | Vendor | Serves embeddings? |
| --- | --- | --- |
| openrouter | OpenRouter | **No.** Embeddings stay on the platform key and are billed |
| gateway | Vercel AI Gateway | Yes |

Direct vendor keys (Anthropic, OpenAI) are a later addition: a new value in
the provider enum plus a provider client in `packages/ai/src/models.ts`.

Call `verify_model_credential` with the same `provider` and `apiKey` first if
you want the vendor's answer before anything is stored. Setting does not
verify on its own.

## Output

The same **redacted** view `get_model_credential` returns: `configured`,
`provider`, `status`, `keyHint` (the last four characters of the key),
`lastVerifiedAt`, and `rotatedAt`. Setting a key never echoes it back, and
there is no read-back path anywhere.

## Side effects

1. **Encrypt first.** The key is envelope-encrypted with the `@oxagen/crypto`
   KMS envelope (the same envelope the data planes and the plugin credential
   vault use) before anything touches a column. If `AUTH_TOKEN_ENCRYPTION_KEY`
   is unset the call is **refused**: a plaintext vendor key must never reach
   Postgres, not even transiently.
2. **Upsert the organisation's `model_credentials` row** with the ciphertext,
   the key id, and a SHA-256 digest of the key. The digest is the provider
   client's cache key, so a rotated key misses the cache and the client bound
   to the old key is dropped rather than retried. `status` resets to `active`,
   `rotated_at` is stamped, and `last_verified_at` resets to null: a newly
   stored key is unverified until `verify_model_credential` runs against it.
3. **The funding source flips** for the next turn. The resolver in
   `@oxagen/ai` reads the row at call time, so no restart is needed. Under an
   OpenRouter key, embeddings keep using the platform key and stay billed.
4. **Audit** a `model_credential.set` security event. The row records that the
   key changed, for which provider, and by whom; the key never appears in it,
   in the structured log, or in any error message.

## Errors

- `AUTH_TOKEN_ENCRYPTION_KEY` unset — refused rather than stored in plaintext.
- Contract validation: an unknown `provider`, or an `apiKey` shorter than 8
  or longer than 512 characters.
- The key is **not** checked against the vendor here. A bad key is stored as
  given and fails on the first completion; use `verify_model_credential`
  first to avoid that.

## Not in this slice

Direct Anthropic and OpenAI keys. Per-workspace keys (the credential is
organisation-wide by design). Automatic verification on set: the settings
page's "Test key" button calls `verify_model_credential` before it calls this.
