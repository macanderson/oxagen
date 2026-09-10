# Model funding source — whose key pays for an organisation's model calls

- **Status:** Implemented
- **Date:** 2026-09-09
- **Author:** platform
- **Related:** [ADR-053](../../adr/ADR-053-in-app-agent-on-stella-serve-and-funding-sources.md)
  (the decision), [ADR-052](../../adr/ADR-052-governed-action-as-the-billable-unit.md)
  (the billing rule this amends), [ADR-042](../../adr/ADR-042-tenant-data-planes.md)
  (the envelope pattern), [ADR-050](../../adr/ADR-050-secret-access-in-the-main-audit-log.md),
  `packages/ai/src/funding-source.ts`, `packages/ai/src/models.ts`,
  `packages/database/src/model-credential-resolver.ts`,
  `packages/billing/src/metering.ts`

---

## 1. Summary

Every model call an organisation makes is paid for by one of two keys. The
organisation's own key, if it has stored one, or Oxagen's platform key. One
resolver answers which, once per turn, and two things follow from the answer:
which key the provider client is built on, and whether the tokens are charged.
The rule both halves implement is one sentence: **a token is billed only when
Oxagen paid for it.**

## 2. The answer, and where it is used

`resolveModelFundingSource(orgId)` returns one of:

| Answer | Meaning |
| --- | --- |
| `{ fundedBy: "platform" }` | no stored key; Oxagen's key pays, tokens are billed |
| `{ fundedBy: "org", credential, keyHint }` | the stored key pays; tokens are reported, not billed |

A stored key whose envelope cannot be opened resolves to the platform key and
logs why, because a turn failing on a customer's own key reads to the customer
as their key being broken, and the platform key is the state every
organisation starts in. A failed database read is different: it propagates and
the turn fails. Guessing "platform" during an outage would move an
organisation that has its own key onto Oxagen's billed key, and that is the
one direction this seam must never err in. The chat routes do not catch it.

The answer is threaded through three places, and they have to agree:

1. **The credit gate.** `evaluateTurnCreditGate(orgId, { fundedBy })` runs
   before the turn. For a platform-funded turn it adds the assistant spend
   cap check (§4). The credit gate itself runs either way: governed tool calls
   consume credits under ADR-052 whoever pays for tokens.
2. **The provider client.** `selectModel({ …, credential })` builds the
   language model on the customer's key when there is one. The platform
   provider switch in the environment is about which key Oxagen pays with,
   and is not consulted when Oxagen is not paying. Clients built on a
   customer key are cached by key digest, so a rotated key is a new client
   and the old one is dropped rather than retried.
3. **The charge.** `streamAgentReply`, `generateObjectFor` and the embedding
   calls take `fundedBy`. Usage is written to `token_usage` in every case;
   `chargeUsageCredits` runs only for `platform`.

A caller that resolves funding for one organisation and charges for another,
or selects a model on the customer key and then charges as platform, has
broken the agreement. The chat routes resolve once and pass the same value to
all three.

## 3. The stored key

`org.model_credentials` holds one live row per organisation: provider,
ciphertext, key id, digest, hint, status, verification and rotation times.
The envelope is the ADR-042 one. The writer encrypts before anything touches
a column and refuses when the encryption key is unset. A read returns the
hint, the provider, and the timestamps, and never the key.

Providers today are `openrouter` and `gateway` (a Vercel AI Gateway key).
Both reach every model in the catalog through one key, which is what makes
them the first two. OpenRouter serves no embeddings, so under an OpenRouter
credential embeddings stay on the platform key and are billed. A direct
vendor key is a new provider value, a provider client in `models.ts`, and a
probe in `credential-probe.ts`.

The four capabilities are `set_model_credential`, `get_model_credential`,
`delete_model_credential` and `verify_model_credential`, org Owner and Admin
only, no billing gate. Set and delete emit `model_credential.set` and
`model_credential.revoked` to the main audit log. The set and delete
capabilities carry no agent metadata, so the in-app agent cannot change the
key that funds its own turns.

## 4. Assistant usage and the cap

When the platform key pays, the in-app agent's tokens are charged with the
ledger reason `consume_assistant_tokens`, at the rate card's vendor cost plus
the meter markup, so they are their own line on the statement. This is the one
case ADR-053 carves out of ADR-052's "tokens are never billed": here Oxagen
holds the vendor invoice.

Each organisation carries `assistant_spend_cap_cents` on its billing settings.
The default is 2000 credits a month. A platform-funded turn is refused before
it starts once the month's `consume_assistant_tokens` debits reach the cap,
with the message naming the cap, the amount spent, and the two ways out: raise
the cap, or store a key. `null` removes the cap and is an operator's choice.
The cap is not consulted for an organisation on its own key.

## 5. What is not here

- Direct Anthropic and OpenAI keys (§3).
- A per-workspace key. The vendor invoice is the organisation's, so the key
  is too.
- Retiring the `consume_token_overage` path that every other caller still
  uses. That is the governed-action metering spec's migration, and this one
  leaves it where it is.
