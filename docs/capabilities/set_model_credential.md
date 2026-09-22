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
| provider | `"openrouter" \| "gateway" \| "openai" \| "anthropic" \| "openai_compatible"` | Which vendor issued the key |
| apiKey | string (8–512 chars) | The plaintext key, as pasted |
| baseUrl | https URL, ≤2048 chars? | `openai_compatible` only, and required there; refused on every other provider |
| modelMap | `{ fast?, balanced?, precise? }`? | The key's own model id per tier. `balanced` required for `openai`, `anthropic`, `openai_compatible`; ignored for the routed two |

| provider | Endpoint | Needs | Serves embeddings? |
| --- | --- | --- | --- |
| openrouter | OpenRouter (routed: every catalog model) | key | **No.** Platform key, billed |
| gateway | Vercel AI Gateway (routed: every catalog model) | key | Yes, on the customer's key |
| openai | `api.openai.com/v1` | key + `modelMap.balanced` | No. Platform key, billed |
| anthropic | `api.anthropic.com/v1` (its OpenAI-compatible endpoint) | key + `modelMap.balanced` | No (Anthropic has no embeddings API) |
| openai_compatible | **the customer's `baseUrl`** — Together, Fireworks, Groq, Azure, self-hosted vLLM, … | key + `baseUrl` + `modelMap.balanced` | No. Platform key, billed |

**Routed vs direct.** A routed key reaches every model in the catalog and
understands Oxagen's tier ids (`anthropic/claude-sonnet-5`) as they are. A
direct key is a different namespace — `api.openai.com` has no model by that
name — so it must say which of its own models each tier means. `balanced` is
required, because it is the tier the assistant runs on. Any tier left unmapped
runs on the balanced model rather than on a platform id the vendor does not
know: the engine sends summarisation to `fast` and verdicts to `precise`, and
falling through to a platform id there would fail the turn halfway through.
The cost is that with only `balanced` mapped, a verdict runs on the same model
as the worker.

**A stored model choice on a direct key.** A workspace or a person may have a
default model saved from before the key existed, and a request may name one.
Those are catalog ids. On a direct key one is read as: one of the map's own
values, passed through; a platform tier id, run on that tier's mapping; a
gateway id for the same vendor (`openai/gpt-5.2` on an `openai` key), sent in
the vendor's spelling; anything else, run on the selected tier's mapping. The
assistant-turn log names the model that ran. Nothing sends a platform id to a
vendor that does not know it.

**Anthropic caveat.** `anthropic` is reached through Anthropic's
OpenAI-compatible endpoint, which does not carry prompt caching. An
organisation that wants cached Claude should use an `openrouter` or `gateway`
key instead; both cache. (A native Anthropic client needs the AI SDK core
upgraded across the repo first — `@ai-sdk/anthropic` pulls a
`@ai-sdk/provider` that is not type-compatible with the pinned one.)

**The endpoint is refused before anything is stored** unless it is `https` and
publicly routable. The check rejects loopback, RFC1918, link-local and the
cloud metadata address in every spelling — including the IPv4-mapped forms
(`[::ffff:169.254.169.254]`) that the URL parser rewrites to hex — and it runs
in the contract, so a bad endpoint is a 400 on every surface. The database
additionally holds `base_url` to `https://` and to exactly the
`openai_compatible` rows.

**An endpoint that carries a credential is refused too.** A URL such as
`https://user:pass@endpoint.example/v1` is rejected with a message naming what
to remove, on `set_model_credential` and `verify_model_credential` alike. The
reason is that `base_url` is stored in the clear and returned by every read:
this column is one of the few places in the product where nothing is a secret,
and a password in the address would make that promise false while looking like
configuration. Send the credential in the request, which is what the `apiKey`
field is for. Node's `fetch` refuses such a URL as well, so an endpoint like
this could never have served a turn. A row stored before this check existed is
returned with its userinfo replaced by `***` and has to be retyped.

Call `verify_model_credential` with the same `provider` and `apiKey` first if
you want the vendor's answer before anything is stored. Setting does not
verify on its own.

## Output

The same **redacted** view `get_model_credential` returns: `configured`,
`provider`, `status`, `keyHint` (the last four characters of the key),
`baseUrl`, `modelMap`, `lastVerifiedAt`, and `rotatedAt`. The endpoint and the
model map are returned in full because neither is a secret. Setting a key never echoes it back, and
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
- Contract validation (`invalid_input`): an unknown `provider`; an `apiKey`
  shorter than 8 or longer than 512 characters; a `baseUrl` missing on
  `openai_compatible` or present on any other provider; a `baseUrl` that is
  not `https` or resolves to a non-routable literal; a direct-vendor key with
  no `modelMap.balanced`.
- The key is **not** checked against the vendor here. A bad key is stored as
  given and fails on the first completion; use `verify_model_credential`
  first to avoid that.

## Not in this slice

A native Anthropic client (see the caveat above). Per-workspace keys (the credential is
organisation-wide by design). Automatic verification on set: the settings
page's "Test key" button calls `verify_model_credential` before it calls this.
