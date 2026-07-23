# ADR-036: Adopt the official CGP TypeScript SDK as the canonical type source

- **Status:** Accepted
- **Date:** 2026-07-23
- **Owners:** agent platform / run-evidence
- **Related:** ADR-035 (amended by this decision), #1082 (consume CGP
  directly), `docs/specs/run-evidence-ingress/spec.md` (Approved — the
  governing seam),
  [`context-graph-protocol#43`](https://github.com/macanderson/context-graph-protocol/pull/43)
  (the SDK this ADR adopts),
  [`@contextgraphprotocol/typescript-sdk`](https://www.npmjs.com/package/@contextgraphprotocol/typescript-sdk)

## Context

ADR-035 chose a **from-scratch TypeScript reimplementation** of the CGP
frame/query contract, proven against pinned golden fixtures — explicitly not a
dependency — because at the time the only upstream artifact was Rust crates:

> A published TypeScript artifact for CGP does not exist, so "just depend on
> upstream" was not on the table for this codebase.

One day later that premise expired. `context-graph-protocol#43` shipped
official provider SDKs (TypeScript, Python, Go); the TypeScript SDK is
published as `@contextgraphprotocol/typescript-sdk` — a zero-dependency
package carrying the canonical wire types (`ContextFrame`, `ContextQuery`,
the envelope union), the §B3 canonical token accounting (`budgetTokens`), and
a stdio provider runner. Separately, the protocol moved: oxagen's fixture pin
(`36a64488`) predates the #33 normative sweep (content-optional frames,
representations, canonical token accounting) that the Rust-side consumer
(Stella, ADR-033) already tracks at `9fb559a`.

## Decision

**`@oxagen/run-evidence` adopts `@contextgraphprotocol/typescript-sdk` as the
canonical source of the CGP wire contract, keeps its Zod validator as the
runtime enforcement layer, and pins the golden fixtures to the same upstream
commit as the Rust-side consumer (`9fb559a`, the #33 sweep).**

Concretely:

1. **SDK anchors the contract.** The protocol version string and §B3 token
   arithmetic are imported from the SDK, not re-derived. The Zod schemas are
   drift-checked against the SDK's `ContextFrame`/`ContextQuery` types at
   compile time: if the SDK adds a wire field the schema does not model, or a
   modeled field's type diverges, the package fails to typecheck. (Verified by
   falsification: removing a schema field or diverging a field type breaks
   `tsc` at the assertion site.)
2. **The Zod validator stays.** The SDK ships plain interfaces and no runtime
   validation; run-evidence's job is validation at a trust boundary. The
   from-scratch normalization/digest/intrinsic-integrity apparatus of ADR-035
   is unchanged — what changes is that its *shape* can no longer silently
   drift from upstream.
3. **Fixture pin bumped `36a64488` → `9fb559a`.** The golden fixture payloads
   are byte-identical between the two commits (verified per-blob and by
   recomputing `upstream_manifest_sha256`), so the bump moves only the
   attested `upstream_commit`. Both CGP consumers in this codebase family now
   sit on the same protocol commit.
4. **#33 semantics are modeled and tested.** Frames: `content` is optional,
   with representation invariants (`full`/`compact`/`reference`) mirrored
   from `contextgraph-types` with byte-identical messages. Queries:
   `representation_preferences`. Token honesty (§B3) and the temporal profile
   (§F4) are exported conformance predicates, mirroring upstream's split
   between parsing and conformance.

## What this amends in ADR-035

ADR-035's clause 2 ("Conformant TS reimplementation … from-scratch") is
narrowed: the implementation remains from-scratch at runtime, but the type
surface it validates is now the SDK's, enforced by the compiler. ADR-035's
"not a dependency" rationale is superseded — it was premised on no TS artifact
existing. Everything else in ADR-035 (pinned byte-parity fixtures, the
drift-check script, evidence labeling) stands and continues to gate.

## Honest limits

- The pinned golden fixtures at `9fb559a` do **not** exercise #33's new
  surface (no representation/content_ref/fidelity vectors) — upstream has not
  regenerated them since the sweep. Local test vectors cover the gap; they are
  package tests, not attested goldens. When upstream regenerates its golden
  fixtures, the mirror and pin should follow.
- §B3 honesty is a conformance predicate, not a parse gate, because the
  pinned golden `context-frame.valid.json` predates the honesty rule and
  would fail it. This mirrors upstream's own structure
  (`representation_invariants` vs `declares_honest_token_cost`).
