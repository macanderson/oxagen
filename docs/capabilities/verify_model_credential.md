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

Ask the vendor whether a key is accepted, and whether each model the
credential maps can serve the assistant. The key check is a **metadata read**
on the vendor's own key endpoint (the call a vendor dashboard makes to show a
key's status), so it costs nothing and needs no model. On a direct vendor the
check then asks each mapped model one question that costs a few output
tokens (see Output).

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
| provider | the five providers of `set_model_credential`? | Which vendor issued the candidate key |
| apiKey | string (8–512 chars)? | The candidate key; never stored by this call |
| baseUrl | https URL? | The candidate endpoint, `openai_compatible` only — range-checked before any request is made |
| modelMap | `{ fast?, balanced?, precise? }`? | The candidate's tier map, as `set_model_credential` stores it. Each mapped model is asked the tool-calling question |
| toolProbeModel | string? | The balanced tier's model, for a caller that names only that one. Ignored when `modelMap` is given |

One cross-field rule, enforced by the contract on every surface: `provider`
and `apiKey` travel **together**. A key with no provider cannot be checked
against anything, and a provider with no key would verify the stored key under
a possibly different provider and report the wrong thing. Give both, or give
neither.

An `openai_compatible` candidate also needs its `baseUrl`, and that URL gets
the same public-endpoint check `set_model_credential` gives it **before** the
probe runs — the probe connects to it with the key attached, so checking
afterwards would be too late.

## Output

| Field | Type | Notes |
| --- | --- | --- |
| ok | boolean | Whether the vendor accepted the key |
| provider | one of the five providers | Which vendor was asked |
| latencyMs | integer ≥ 0 | Round trip to the vendor |
| error | string \| null | The vendor's own message when `ok` is `false`, or its reason for refusing tools; `null` when both passed |
| toolCalling | boolean \| null | Whether every mapped model can call tools. See below |
| toolCallingByTier | `{ fast?, balanced?, precise? }`? | Each asked tier's answer: `true`, `false`, or `null` when the model ran out of output before it answered. A tier the probe did not ask is absent |
| failingTier | `fast` \| `balanced` \| `precise` \| null? | The first tier, in that order, whose model could not call tools |

**What the probe asks, per tier (#3314).** A key the vendor accepts is not yet
a working assistant. Every turn is the engine asking the model for tool calls
and acting on them, and the runtime selects every tier: `balanced` runs the
turn, and `modelForRole` sends summaries and verdicts to `fast` and
`precise`. So on an `openai`, `anthropic` or `openai_compatible` key the probe
sends one completion to each model the credential maps, with one tool offered
and `tool_choice` forcing it. It sends it to the OpenAI-compatible endpoint the
runtime client calls: `https://api.openai.com/v1`, `https://api.anthropic.com/v1`,
or the customer's `baseUrl`. A model mapped to several tiers is asked once.

- The cap on each completion's output is `max_completion_tokens: 1024` on
  OpenAI (its reasoning models refuse `max_tokens` and reason before they
  call), `max_tokens: 64` on Anthropic, and `max_tokens: 16` on an
  OpenAI-compatible server. A forced call with no arguments uses far less.
- `toolCalling` is `false` when any tier's model answered without a tool call
  or refused the request, and `error` then names the tier, its model, and the
  vendor's reason, for example `balanced tier (gpt-5.2): ...`. It is `null`
  when a model ran out of output first, or when the key was refused so the
  question never came up.
- `toolCalling` is `true` without asking for `openrouter` and `gateway` keys,
  which run the platform's own tier ids, and for a named-vendor candidate
  sent with no tier map.

**Structured outputs, `openai_compatible` only.** The probe also asks the
`fast` model (or `balanced` when `fast` is unmapped) for one answer under a
`response_format` JSON schema, in the request shape
`@ai-sdk/openai-compatible` sends, capped at 64 output tokens. The answer
counts as honoured when the reply parses and matches the schema. On the
stored key, the answer is kept on the credential (`structured_outputs`), and
`get_model_credential` returns it as `structuredOutputs`. The provider client
sends a JSON schema to that endpoint only when the stored answer is `true`.
Otherwise it sends JSON mode, and `generateObjectFor` puts the schema in the
system prompt, so run summaries and history summaries still come back in the
right shape. A candidate's answer is not stored, because the candidate is not.

`error` is the vendor's text **about** the key, never the key. The response
never carries the key in either direction.

## Side effects

- **Candidate key:** none. Nothing is stored, no row changes, and no security
  event is emitted, because no key was written.
- **Stored key:** on `ok: true` **and** `toolCalling` not `false`,
  `last_verified_at` is stamped. On an `openai_compatible` key with
  `ok: true`, the structured-output answer is written to `structured_outputs`
  whatever `toolCalling` says, and the cached credential is dropped so the
  next completion builds its client on the new answer. A key that works on an endpoint that cannot
  call tools is not stamped, because that column is what the settings page
  shows as healthy. It is otherwise stamped on the live
  `org.model_credentials` row, which is what `get_model_credential` reports
  as `lastVerifiedAt`. On `ok: false` the row is left as it was. These are
  the only writes, and they are why the MCP tool is annotated read-only: a
  timestamp that says "this passed at time T" and a record of what the
  endpoint did change no state a caller relies on.

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
key's **balance** — the check confirms the key is accepted and, for a custom
endpoint, that the named model can call tools; not that it can afford a turn.
