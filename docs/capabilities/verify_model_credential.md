# verify_model_credential

**Domain:** org
**Mode:** sync
**Scope:** organisation (`scoped: false` — requires an orgId, no workspace)
**Surfaces:** api, mcp
**Sensitivity:** high · **Default effect:** deny · **Roles:** org Owner, Admin
**Billing gate:** none · **Agent tool:** no

Contract: `packages/oxagen/src/contracts/org.model_credential.verify.ts`
Handler: `packages/handlers/src/org.model_credential.verify.ts`
API: `POST /v1/:org/:workspace/org/model-credential/verify`
MCP: `apps/mcp/src/tools/org.model_credential.verify.ts`
Decision record: [ADR-053](../adr/ADR-053-in-app-agent-on-stella-serve-and-funding-sources.md)

## Intent

Ask the vendor whether a key is accepted, without spending tokens. The check
is a **metadata read** on the vendor's own key endpoint (the call a vendor
dashboard makes to show a key's status), so it costs nothing and needs no
model.

Two uses, told apart by the input:

- **A candidate key** (`provider` and `apiKey` given): verify before anything
  is stored. This is what the settings page's "Test key" button calls before
  `set_model_credential`, so a mistyped key is caught with the vendor's own
  message rather than on the first completion.
- **The stored key** (empty body, `{}`): verify the key already stored for the
  organisation and stamp `last_verified_at` on success. This is what a health
  sweep calls, and what an operator calls to check a key that has been in
  place for a while.

A refusal is **reported, not thrown**: the vendor's message about the key is
the output the operator needs to fix it.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| provider | `"openrouter" \| "gateway"`? | Which vendor issued the candidate key |
| apiKey | string (8–512 chars)? | The candidate key; never stored by this call |

One cross-field rule, enforced by the contract on every surface: `provider`
and `apiKey` travel **together**. A key with no provider cannot be checked
against anything, and a provider with no key would verify the stored key under
a possibly different provider and report the wrong thing. Give both, or give
neither.

Providers today are `openrouter` and `gateway` (Vercel AI Gateway); direct
Anthropic and OpenAI keys are a later addition.

## Output

| Field | Type | Notes |
| --- | --- | --- |
| ok | boolean | Whether the vendor accepted the key |
| provider | `"openrouter" \| "gateway"` | Which vendor was asked |
| latencyMs | integer ≥ 0 | Round trip to the vendor |
| error | string \| null | The vendor's own message when `ok` is `false`; `null` when it passed |

`error` is the vendor's text **about** the key, never the key. The response
never carries the key in either direction.

## Side effects

- **Candidate key:** none. Nothing is stored, no row changes, and no security
  event is emitted, because no key was written.
- **Stored key:** on `ok: true`, `last_verified_at` is stamped on the live
  `org.model_credentials` row, which is what `get_model_credential` reports
  as `lastVerifiedAt`. On `ok: false` the row is left as it was. This is the
  only write, and it is why the MCP tool is annotated read-only: a timestamp
  that says "this passed at time T" changes no state a caller relies on.

Opening the stored envelope to read the key is recorded in the main audit log
like every other secret access (ADR-050).

## Errors

- Contract validation: `provider` without `apiKey`, or `apiKey` without
  `provider`; an unknown `provider`; an `apiKey` outside 8–512 characters.
- A key the vendor refuses is **not** an error: it comes back as `ok: false`
  with the vendor's message in `error`, so the settings page can show it.
- A vendor that cannot be reached (DNS, a refused connection, the probe's
  timeout) is reported the same way, as `ok: false` with the transport
  failure as `error`; the probe never throws, and it scrubs the key out of
  any message before returning it.
- Verifying the stored key when none is stored **is** an error ("No model
  credential is stored for this organisation"), because there is nothing to
  ask the vendor about; call `get_model_credential` first if that is
  uncertain.

## Not in this slice

A scheduled health sweep that calls this on every stored key. The stored-key
form exists so one can be built; nothing runs it on a timer today. Verifying a
key's **balance** or **model access** — the check confirms the key is accepted
by the vendor, not that it can afford a turn or reach a given model.
