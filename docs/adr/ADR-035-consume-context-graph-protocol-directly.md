# ADR-035: Consume the Context Graph Protocol directly via pinned conformance fixtures

- **Status:** Accepted
- **Date:** 2026-07-22
- **Owners:** agent platform / run-evidence
- **Related:** #1082 (this decision), #1069 (pruned the vendored `ocp-*`
  crates), #1098 (added the run-evidence contract core),
  `docs/specs/run-evidence-ingress/spec.md` (Approved — the governing seam),
  ADR-033 (Stella Rust engine core — the other, Rust-side CGP consumer),
  [`context-graph-protocol`](https://github.com/macanderson/context-graph-protocol)
  (the canonical upstream, formerly Open Context Protocol / `ocp-*`)

## Context

The protocol formerly known as the Open Context Protocol was renamed the
**Context Graph Protocol (CGP)**; its Rust crates were renamed `ocp-*` →
`contextgraph-*` (`contextgraph-types`, `contextgraph-host`,
`contextgraph-conformance`). Issue #1082 asks oxagen to replace its
"separate, un-renamed `ocp-*` copy" with the canonical `contextgraph-*` code —
"preferably as a dependency on the canonical repo (git tag now, crates.io once
context-graph-protocol#16 ships) instead of a vendored copy."

That framing assumes a **Rust crate** dependency and a vendored **Rust** copy.
Neither survives on `oxagen-platform` today:

- The vendored Rust workspace `crates/ocp-*` was **ejected-Stella** code. It was
  removed wholesale in #1069 ("chore: prune ejected Stella and Open Context
  Protocol artifacts"). `oxagen-platform` now carries **zero** Rust crates
  (`git ls-tree -r origin/main | rg '\.rs$'` → 0 files), so there is no target
  in this repo for a git-tag/crates.io Rust dependency.
- oxagen-platform's actual CGP consumer is a **TypeScript** contract core,
  `@oxagen/run-evidence` (added in #1098): `contextgraph.ts`, `json-wire.ts`,
  `digest.ts`, `limits.ts`. It is the "first vertical slice" of the governed
  run-evidence ingress seam (`docs/specs/run-evidence-ingress/spec.md`,
  Status: Approved) and is not yet imported by an app or worker.

The Approved run-evidence-ingress spec already frames the choice as an
either/or:

> The integration must either consume the current CGP crate directly or prove a
> narrow adapter against the same golden frame/query fixtures and protocol
> version. Until that gate passes, evidence labels the context source as the
> legacy adapter rather than `context-graph-protocol`.

This ADR resolves that either/or **for the oxagen-platform (TypeScript) side**.
It does not restate the spec; it records the decision the spec left open.

## Decision

**oxagen-platform consumes the Context Graph Protocol directly by pinning CGP's
normative conformance fixtures byte-for-byte, and proving the TypeScript
contract core conformant against those golden vectors — not by taking a Rust
crate dependency and not by vendoring an `ocp-*` copy.**

Concretely:

1. **Pinned canonical fixtures.** `packages/run-evidence/fixtures/contextgraph/`
   holds CGP's golden conformance vectors copied verbatim from the canonical
   repo, pinned to a specific `upstream_commit`
   (`context-graph-protocol@36a64488`, fixture profile `1.1.0`), with per-file
   `sha256` digests and an `upstream_manifest_sha256` recorded in
   `manifest.json`. These are the same files CGP itself generates via
   `cargo test -p contextgraph-conformance --test golden_fixtures`. Byte parity
   with upstream is verified (see below), so the "vendored copy" is a pinned
   mirror, not a fork.

2. **Conformant TS reimplementation.** The contract core in
   `packages/run-evidence/src/` is a from-scratch TypeScript implementation of
   the frame/query validation, normalization, and digest surface CGP defines,
   validated against the pinned golden vectors in the same package's test suite.
   It is the single sanctioned CGP consumer in this repo. There is no
   `ocp-*`-named module anywhere in the source tree.

3. **Drift gate.** `tools/scripts/check-contextgraph-fixtures.ts` freezes the
   expected protocol version, profile version, generation command, upstream
   repository, upstream commit, upstream manifest digest, and each fixture's
   raw-byte digest. Run offline it verifies the vendored bytes against those
   frozen digests. Given a canonical checkout via `CONTEXT_GRAPH_PROTOCOL_DIR`
   it upgrades to **full byte-parity verification**: the checkout must be at the
   pinned commit, its origin must be the canonical repo, and every fixture must
   be byte-identical to upstream. This ADR wires that check into `pnpm gate` and
   the lefthook `pre-push` hook so drift from the pin fails the gate.

We explicitly do **not**:

- take a git-tag or crates.io **Rust** dependency here — canonical CGP is
  Rust-only, publishes no TypeScript artifact, and the crates.io path
  (context-graph-protocol#16) is for Stella's Rust engine, not this monorepo;
- vendor an `ocp-*` copy — none remains after #1069;
- promote oxagen's `RunEvidenceManifestV1` / Stella's `CompiledContextFrame`
  into CGP wire types — per the spec ownership boundary, CGP owns the portable
  `ContextFrame`/`ContextQuery`; Oxagen owns the evidence manifest bridge.

## Documented delta from canonical

Per #1082's acceptance ("any local delta documented"):

- **Language.** Canonical is Rust; oxagen's consumer is TypeScript. Behavioral
  equivalence is asserted only over the pinned golden fixtures and normalization
  vectors, not over the whole crate surface.
- **Scope.** oxagen reimplements only the frame/query validation, JSON-wire
  normalization, digest, and limits needed for run evidence. It does not port
  the host/transport crates (`contextgraph-host`) — those have no consumer in
  this repo.
- **Hardening (additive).** `contextgraph.ts` captures pristine intrinsics and
  guards against prototype-pollution at module load. This is defense-in-depth in
  the TS runtime, not a wire-format change; it does not diverge from the
  protocol.
- **Fixture content.** Zero. The vendored fixtures are byte-identical to
  `context-graph-protocol@36a64488` (verified by the parity check).

## Consequences

- **Bumping the protocol** is a mechanical, gated operation: re-run the upstream
  generation command, copy the new fixtures + `manifest.json`, update the frozen
  `EXPECTED_*` digests and `upstream_commit` in
  `check-contextgraph-fixtures.ts`, and re-verify parity. The gate blocks silent
  drift between oxagen's mirror and canonical.
- **Enforcement is honest about this repo's reality.** GitHub Actions is
  currently non-functional on oxagen-platform, so the live enforcement paths are
  the lefthook `pre-push` hook and the local `pnpm gate` (gated by the PR-review
  checklist). The offline drift check is fast, deterministic, and dependency-free
  beyond `tsx`, so it is safe in both. Full byte-parity against a live canonical
  checkout is opt-in via `CONTEXT_GRAPH_PROTOCOL_DIR` and belongs in a machine
  that has the upstream repo cloned.
- **`@oxagen/run-evidence` is not yet imported by an app or worker.** It is the
  in-progress ingress slice. When it is wired in, it consumes canonical CGP
  through this pinned surface with no additional divergence risk — the decision
  is forward-compatible with the ingress build-out.

## Out of scope — the Stella (Rust) side

Stella's Rust engine still depends on pinned `ocp-types`/`ocp-host`. The
run-evidence-ingress spec requires Stella to either consume the current CGP
crates directly or prove a narrow adapter against the same golden fixtures
before its evidence may label the context source `context-graph-protocol`. That
migration lives in the [`stella`](https://github.com/macanderson/stella) repo
and is tracked there; **this ADR governs the oxagen-platform (TypeScript) side
only.** Whether #1082 closes on the TS resolution alone or stays open to track
the Stella crate swap is a call for the issue owner.

## Alternatives considered

- **Rename the vendored `ocp-*` crates → `contextgraph-*` in place.** Moot: no
  vendored crate copy remains on oxagen-platform after #1069.
- **Git-tag / crates.io Rust dependency (the issue's stated preference).** Not
  applicable to a TypeScript monorepo with no Rust build. Reserved for Stella,
  where a real crate dependency is the right mechanism.
- **Re-fork the CGP Rust crates into a napi-rs binding for TS.** Over-engineered
  for the narrow validation/normalization surface run-evidence needs; it would
  add a native build to the web/worker toolchain to reproduce logic the pinned
  golden-fixture conformance already guarantees. Rejected.
- **Consume canonical fixtures without a drift gate.** The pin is only
  trustworthy if something enforces it; an unenforced mirror silently diverges —
  exactly the failure mode #1082 describes. Rejected in favor of wiring the
  check into the gate.
