# ADR-047: No provider-posture matrix; handle divergence at the gateway

- **Status:** Accepted
- **Date:** 2026-09-07
- **Owners:** platform
- **Related:** issue #2630 (the epic asking this question), issue #2629
  (OpenRouter refusing a request on `max_tokens`, the one gap found so far),
  `packages/ai/src/models.ts`, `packages/ai/src/output-budget.ts`,
  `macanderson/stella`'s `crates/stella-model/src/provider_parity.rs`

## Context

Model providers diverge in ways that are invisible until one bites: a
token-budget refusal, a broken stream, a cache that reports hits differently.
`macanderson/stella` keeps a matrix for exactly this — one row per provider per
axis, each naming a witness test — because a gap there was found four times by a
benchmark run paying for it rather than by a test.

#2630 asks whether oxagen needs the same thing.

## Decision

**No matrix. Divergence is handled where it occurs, which here is the gateway.**

The two codebases are not in the same position, and the difference is
structural rather than a matter of maturity.

**stella calls vendors directly.** It ships an adapter per vendor — `anthropic.rs`,
`openai.rs`, `gemini.rs`, `vertex.rs`, `bedrock.rs`, `zai.rs` — so a behaviour
that differs between Anthropic and OpenAI differs between two files it owns.
A matrix is the only way to know which file is missing which handling.

**oxagen calls one gateway.** `packages/ai/src/models.ts` imports `gateway` from
`@ai-sdk/gateway` and resolves every model through `gateway.languageModel()`.
There is one call path in front of every vendor.

That is not a detail. #2629 is the evidence: OpenRouter refused a request
because it prices against the requested `max_tokens` rather than what the reply
spends. **The credit check belongs to the gateway, not the vendor** — the refusal
happens before the request reaches Anthropic, OpenAI, Google, xAI, Meta,
Mistral, DeepSeek or BFL. A per-vendor matrix would have carried eight identical
rows describing behaviour no vendor has, and the honest place to record it was
the single caller in front of all of them. The fix lives in
`packages/ai/src/output-budget.ts` for that reason.

## What we give up, stated

**A matrix makes absence visible.** Its real value is not the rows that are
filled in but the ones that are conspicuously empty — an axis nobody has checked
for a provider reads as a gap rather than as silence. Declining it means a
divergence oxagen has not met yet will be found the way #2629 was: by something
breaking.

That is accepted here because the shape of the risk is different. A gap behind a
single gateway is one gap, in one file, affecting every model equally — it is
found once and fixed once. A gap across six vendor adapters is six gaps that can
each be fixed in five places and missed in the sixth, which is what a matrix
exists to prevent.

## When to revisit

**The moment `@ai-sdk/gateway` stops being the only path.** If oxagen adds a
direct vendor client — for a model the gateway does not carry, for latency, or
to use a vendor feature the gateway flattens — the reasoning above expires that
day, and this decision should be reopened rather than inherited.

A second trigger: a third distinct gateway-level divergence. One (#2629) is an
incident; three is a class, and a class wants a table.

## Consequences

- `@oxagen/ai` handles provider-specific failures in the shared layer, with a
  named module per behaviour (`output-budget.ts` is the first), rather than a
  posture declared per provider.
- Each such module carries the tests that prove the behaviour, which is the
  half of stella's matrix that transfers — the witness, not the grid.
- #2630 closes on this decision. Its one sub-issue, #2629, is fixed.
