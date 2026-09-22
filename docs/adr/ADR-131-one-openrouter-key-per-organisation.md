# ADR-131: One OpenRouter key per organisation, and funding is decided with the model

- **Status:** Accepted
- **Date:** 2026-09-20
- **Owners:** Mac (funding policy), platform
- **Numbering:** 131. ADR-114 through ADR-130 were taken while this work was in progress, so an earlier draft's ADR-114 references were renumbered.
- **Related:** ADR-053 (model funding and BYOK), ADR-055 (the two meters), ADR-042 (data planes), `docs/specs/tenancy-rls/spec.md`, `packages/ai/src/funding-source.ts`, `packages/ai/src/platform-provider.ts`, `packages/database/src/assistant-model-key.ts`
- **Amended:** 2026-09-22, §9 added (the platform-provider gate and the ceiling refusal).

## Context

Every organisation that does not bring its own model key runs the in-app
assistant on one shared OpenRouter key. That key works. What it cannot do is
say which customer spent what.

OpenRouter reports usage per key. With one key for every customer, the vendor's
own figure is a single number for the whole platform, so Oxagen's invoice to a
customer rests entirely on Oxagen's own meter with nothing on the vendor's side
to check it against. When a customer disputes a line, or an auditor asks how
the number was derived, the answer is one internal system and no second source.
The shared key also has one blast radius: a bug in one organisation's turns
spends against the ceiling every other organisation depends on.

A second problem surfaced while reading the funding code. `resolveModelFundingSource`
answers who is invoiced for a turn. Fifteen call sites read `fundedBy` off that
answer and then built the model with a credential-less `selectModel({ tier })`.
The two halves had drifted apart: the funding answer said the customer's own key
paid, and the model was built on Oxagen's shared key, so Oxagen paid the vendor
and billed the customer nothing. This is a billing defect, not a style problem,
and it was invisible because each half was correct on its own.

## Decision

### 1. Oxagen mints one OpenRouter key per organisation, on its own account

At organisation creation, after the transaction commits, Oxagen calls the
OpenRouter provisioning API and mints a key for that organisation alone. The key
is enveloped with the platform KEK and stored in `org.assistant_model_keys`, one
row per organisation, with the vendor's `hash` as the durable handle.

The mint runs detached from signup. It calls a third party over HTTPS, and the
organisation transaction must not be held open across a vendor's latency, nor
rolled back by one: a rollback after a successful mint strands a live, spendable
key with no row in Postgres to find it by. An organisation whose key was not
minted serves on the shared key, which is what every organisation did before
this record. The assistant works, the credits are charged the same, and what is
lost is the vendor-side figure until a backfill fills it in.

### 2. The key's name is fixed at creation and never rewritten

The name is `oxagen/<org-slug>/<creator-email>`, lowercased, with control
characters stripped and `/` inside a field replaced by `-` so a field cannot be
forged. It is bounded at 120 characters, truncating the email rather than the
slug.

The slug is copied into the name at mint time and is not a reference to the
organisation's current slug. An organisation that renames itself keeps the key
it has, under the name it was minted with. The name is a label an operator reads
in the OpenRouter dashboard; the row's identity is `org_id`, and the vendor's is
`hash`. Neither moves when a slug does.

The creator's email is in the name because a person who belongs to several
organisations needs the pair to tell their keys apart in a vendor list that has
no other Oxagen context in it.

### 3. Each key carries a daily spend ceiling

Every minted key is created with `limit`, `limit_reset: "daily"`, and
`include_byok_in_limit: false`. The ceiling is `OPENROUTER_ORG_KEY_DAILY_LIMIT_USD`,
default 25.

Twenty-five dollars is chosen against two numbers that already exist. A new
organisation receives a $5 signup grant (ADR-055), and the credit gate stops a
free organisation at roughly $5 of metered spend, so the ceiling is not what
bounds an ordinary free account. It sits well above a heavy legitimate day for
one organisation and far below the account-wide ceiling, which is what makes it
useful: it bounds one organisation's bad day without reaching the rest.

A key with no ceiling is refused. When the configured value is missing, zero,
negative or unparseable, the provisioner falls back to 25 rather than minting
uncapped. A key that exists with a sane cap beats no key, and both beat a key
with no cap.

### 4. A minted key changes which key spends, never who is billed

`org.model_credentials` means the customer brought a key and pays the vendor
directly, so Oxagen bills no tokens for those turns. `org.assistant_model_keys`
means the opposite: Oxagen pays the vendor, on a token minted for one
organisation. Metering, markup and the credit gate are exactly what they were on
the shared key.

The two tables are therefore separate, and a minted key is never written into
`model_credentials`. Storing it there would flip `fundedBy` to `"org"` and Oxagen
would bill nothing for tokens it paid for.

`ModelFundingSource` now carries two independent fields:

- `fundedBy` says who is invoiced: `"platform"` or `"org"`.
- `modelKey` says which key the provider client is built on, and is absent for
  the shared key.

An organisation with a minted key resolves to `fundedBy: "platform"` with a
`modelKey`. That combination is new, and it is the reason `fundedBy` can no
longer be read as "does this organisation have a key?".

### 5. The model and its funding are resolved in one call

`selectModelForOrg(orgId, selector)` returns `{ model, fundedBy }`. It resolves
the funding source, builds the model on whatever key that source names, and
returns both. The two halves cannot be separated by a caller, because a caller
never sees them apart.

The field rename from `credential` to `modelKey` is deliberate and is the
durable choice under SCR-002: it turns every stale consumer into a compile error
rather than a silent reconciliation gap. All fifteen drifted call sites were
converted in the change that introduced this record.

### 6. Failure resolves to the shared key, and says why

Every read failure in `loadAssistantModelKey` returns null and logs an alert: an
unset KEK, an envelope that cannot be opened, a row marked disabled. Falling back
is the safe direction in all three. The alternative is an assistant that stops
answering for a customer over a key-management problem they cannot see and did
not cause. The cost of the fallback is attribution, not money, because the tokens
are Oxagen's either way and the meter charges the same turn the same amount.

The write path is the opposite and throws on both of its failure modes. Each one
leaves a spendable key at the vendor that nothing references, and the caller's
catch is what deletes it. A write that returns quietly strands a key.

### 7. Idempotence is the unique index, not the pre-read

The provisioner reads first, mints second, stores third. The read is an
optimisation, so the common already-provisioned case costs one indexed read and
no vendor call. The `org_id` unique index is the actual idempotence, because two
callers can both read "no row" before either inserts. The caller that loses the
insert deletes the key it just minted and reports `race`, which is an ordinary
outcome and not logged as a failure.

Minting before writing is the correct order. A crash between them leaves an
orphan an operator can clean up. Writing first would leave a row referencing a
key that does not exist, which fails every turn for that organisation.

### 8. A disabled key is never deleted

Switching an organisation's key off sets `status = 'disabled'` and a timestamp.
The row stays. A deleted row takes its usage history with it, and the invoice for
the month it was deleted in stops reconciling.

### 9. A minted key serves only where the platform routes through OpenRouter

A minted key is an OpenRouter key, and `selectModel` builds any credential it
is handed into that credential's own client. On a deployment whose platform
provider is the gateway (`OXAGEN_MODEL_PROVIDER=gateway`, the default), a
minted key would therefore move the organisation's turns off the gateway and
out of its metering the moment `OPENROUTER_MANAGEMENT_KEY` was set. The env
registry says the provider switch is never an automatic fallback, and this
would have been one.

So the platform provider gates both halves. `ensureAssistantModelKey` returns
`provisioned: false, reason: "disabled"` on a gateway deployment before it
reads the management key, and `resolveModelFundingSource` does not read the
minted-key row there: the shared key answers, and one log line per process
says so. A key the customer brought is unaffected, because it names its own
provider and the customer chose it. `packages/ai/src/platform-provider.ts`
is the one place both sites ask.

A key that reaches its daily ceiling (§3) is refused by the vendor with a 402.
`selectModelForOrg` wraps a model built on a minted key so that refusal
reaches the caller as `AssistantModelKeyLimitError`, whose message the
assistant can show and whose `code` a surface can branch on. The call path
does not fall back to the shared key. The ceiling bounds what one
organisation can spend on the account every other organisation depends on,
and a retry on the shared key would spend past it the moment it was reached.
§6's fallback is for a key that cannot be read, not for a key that has
spent its ceiling.

## Consequences

**What this buys.** OpenRouter's per-key usage export joins to Oxagen's customers
on `key_hash`, so a customer's invoice has a second source that Oxagen does not
control. One organisation's spend is bounded by its own ceiling. An enterprise
customer can be shown the key that serves it and the ceiling on it.

**What it costs.** One more secret per organisation to hold, rotate and revoke.
One more vendor call on the signup path, detached. A reconciliation report that
has to be written and read, because a failed mint is silent by design and only
that report makes the gap visible.

**The management key is held in one module.** `packages/ai/src/openrouter-provisioning.ts`
reads `OPENROUTER_MANAGEMENT_KEY` and nothing else does. It never reaches a
provider client, a tenant scope or a log line. `OpenRouterProvisioningError`
scrubs `sk-or-v1-` material out of every message it carries, because a vendor
error body is a place a key can appear.

**No management key means no provisioning, and no warning.** That is the shape of
every developer laptop. `ensureAssistantModelKey` returns `provisioned: false,
reason: "disabled"` without calling the vendor.

**Existing organisations keep the shared key** until the backfill runs. Nothing
about their billing changes when it does.

## Alternatives considered

**Keep one shared key.** Simplest to operate and the status quo. Rejected because
it cannot produce a per-customer figure from the vendor, which is the whole
reason for the work, and because it gives every organisation the same blast
radius.

**One key per workspace.** Finer attribution, and wrong: the invoice is per
organisation, so per-workspace keys would need summing back to the level that is
billed, and the key count would grow with a dimension nobody bills on.

**Store the minted key in `org.model_credentials`.** Reuses a table, a resolver
and a cache that already exist. Rejected because that table's presence is what
flips `fundedBy` to `"org"`. Oxagen would pay the vendor and bill nobody, and the
defect would look exactly like correct BYOK behaviour.

**Mint inside the organisation transaction.** Removes the detached path and its
reconciliation gap. Rejected because it holds a Postgres transaction open across
a third party's latency, and because a rollback after a successful mint strands a
spendable key.
