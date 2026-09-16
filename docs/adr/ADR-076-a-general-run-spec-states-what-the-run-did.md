# ADR-076 — A general run's spec states what the run did

- Status: accepted
- Date: 2026-09-16
- Amends ADR-053 (the in-app agent on stella-serve) and the `RunSpecV2`
  vocabulary in `packages/run-ledger/src/run-spec-v2.ts`.

## Context

`RunSpecV2` was designed around `repo_edit`: a bounded, sandboxed run against a
pinned repository, with an enumerated tool allowlist and a framed context
budget. `general` was added for a run that frames context and calls tools but
binds no repository, and it inherited every section from the same shape.

ADR-053's in-app agent turn is a `general` run. The spec it sealed said:

```
workspace_policy: { sandbox_required: true }
context_policy:   { provider_allowlist: [], max_frames: 0, max_tokens: 0, … }
tool_policy:      { allowlist: [], risk_ceiling: "high" }
```

Every one of the first four values was false. The turn runs in this process
through `kernel.invoke()` with no sandbox anywhere. It frames a recalled-memory
message and a page-context message. It materialises the whole governed
capability catalogue, and the model reaches the rest of it through the belt's
two meta-tools.

The seal attests to the spec's digest. So the run's own evidence contradicted
the run: a reader following the trace would conclude a sandboxed run had framed
no context and called no tools, while the log, the receipts and the reply all
say otherwise. For a product whose thesis is one provable trace, a structurally
valid and factually false spec is worse than no spec, because it is believed.

Three constraints made the false values the only expressible ones:

1. `workspace_policy.sandbox_required` is `z.literal(true)`, shared by both run
   kinds. There was no way to say "not sandboxed".
2. `tool_policy.allowlist` was bounded at 256 unique capability names. The
   registered catalogue was around 271, so a run whose tools are the catalogue
   could not name them; the empty array was the only array that fit.
3. `context_policy` had no wrong shape — it was simply filled with zeros.

## Decision

**A `general` run's spec records what that run actually ran under, and the
schema is widened exactly as far as that requires.**

1. `general` runs carry their own `workspace_policy`, where `sandbox_required`
   is a `boolean`. `repo_edit` keeps `z.literal(true)` and the guarantee it
   encodes: an admission path that cannot create a sandbox fails with a typed
   unavailable error rather than admitting an unsandboxed edit. Splitting the
   policy by run kind gives the general kind a truthful field without touching
   what the repo-edit kind promises.
2. `tool_policy.allowlist` is bounded at `TOOL_ALLOWLIST_MAX = 1024` instead of
   256. The bound exists to stop an unbounded array, not to cap policy, and a
   bound below the catalogue is a bound that forces a lie.
3. The assistant turn passes its real values: `sandbox_required: false`, the
   two context providers it assembles (`engram`, `page`) with the frame and
   token ceilings they run under, and the capability names `materializeTools`
   resolved plus the belt's two meta-tools, deduplicated and sorted so two
   turns holding the same set digest the same.

## Alternatives

**Leave the values and explain them in a comment.** A comment is not in the
digest. The seal attests to the spec, and the spec is what a reader, an
auditor, or a later verifier sees. The falsehood would survive every reading of
the code that explains it.

**Drop the sections a general run cannot fill.** Making `workspace_policy`,
`context_policy` or `tool_policy` optional on `general` removes the field
rather than correcting it, and an absent policy is indistinguishable from a
producer that forgot one. Present and true beats absent.

**Sandbox the assistant turn so `true` becomes honest.** ADR-043 is explicit:
Oxagen governs agents and does not run them. There is no sandbox in this repo
and none may return. The turn is a governed question answered over the fleet
record; the thing that bounds it is IAM, entitlement, the belt and the budget,
not an execution boundary.

## Consequences

- A general run's spec can be read as a statement of fact. The assistant turn's
  says: not sandboxed, two context providers, these capabilities, risk ceiling
  high — all of which match what the receipts show.
- `repo_edit` is unchanged in every respect, including the tests that refuse
  `sandbox_required: false` on one.
- The widened tool bound is backward compatible: every spec that parsed before
  still parses.
- A future run kind inherits the question rather than the answer. The rule this
  records is the general one: a spec section that cannot state the truth about
  a run is a schema defect, not a rounding error.

## Enforcement

- `packages/run-ledger/src/run-spec-v2.test.ts` — a general run may say it was
  not sandboxed, a repo edit may not, a non-boolean is still refused, and an
  allowlist the size of the catalogue parses while an unbounded or duplicated
  one does not.
- `packages/agent/src/runtime/assistant-run.test.ts` — the turn's spec pins the
  policies it runs under, with `max_frames` asserted greater than zero and the
  tool allowlist asserted deduplicated and ordered.
