# 5. Tacho traces are a standalone hash-chained format, exported to CGP — not CGP frames at the source

- Status: accepted
- Date: 2026-08-31

## Context

Tacho records every agent action as evidence (design:
`docs/design/tacho/trace-model.md`). Two format questions had to be settled:

1. Should events be emitted natively as CGP frames, given that CGP already
   defines digests, bi-temporal validity, and an episode kind that fits
   "a record of something that happened"?
2. What makes the record trustworthy to a third party (an insurer) who trusts
   neither Oxagen nor the enterprise?

CGP is deliberately a context *retrieval* protocol — the site's own docs draw
the boundary explicitly: tool invocation and action are out of scope (that
side belongs to MCP and to the runtimes). An action recorder emitting CGP
frames at the source would stretch the protocol across its own boundary and
couple Tacho's hot path to a wire format designed for query/response, not
append-only streaming.

## Decision

**A standalone `tacho/1.0` event format, hash-chained per session and
Merkle-anchored, with a defined export mapping to CGP and to OpenTelemetry.**

- Events are canonical JSON (RFC 8785 JCS — the same canonicalization CGP's
  conformance fixtures use), chained `sha256(prev ‖ event)` per session, with
  collector-signed, control-plane-countersigned checkpoints whose hashes are
  anchored in a public Merkle log with a daily published root.
- OpenTelemetry is the observability projection: OTLP export with GenAI
  semantic conventions, `oxagen.tacho.*` attributes for the rest. It is a
  convenience view, not the evidentiary record.
- CGP is the retrieval projection: one `episode` frame per session (final
  chain hash as `canonical_content_hash`, bi-temporal session bounds),
  `memory` frames for distilled behavior, `fact` frames for notable events,
  and namespaced `tacho.*` relations — served by a standard CGP provider
  declaring `DataFlow { egress_scopes: ["local-only"] }` by default. Agents
  query their own operational history through the protocol they already use
  for context; CGP's scope stays clean.

## Why durable

The boundary respects both protocols' reasons to exist. CGP's guarantees
(provenance, budget honesty, verifiable digests) are retrieval guarantees;
tamper-evidence for an append-only action stream is a different property with
a different mechanism (chaining + anchoring). Fusing them would make each
protocol hostage to the other's evolution. Kept separate, either side can
version independently and the export mapping is the only contract — a table
in a document, cheap to revise, impossible to be trapped by.

Anchored hash chains are also the only option here that needs no trusted
party: an insurer verifies inclusion proofs against a published root. Any
scheme resting on "trust Oxagen's database" fails the product's own premise
and would have to be replaced the day a serious underwriter did diligence.

## Consequences

- Two projections (OTel, CGP) must be kept in sync with the envelope schema;
  the mapping tables in `trace-model.md` are the single source of truth.
- The public Merkle log is new infrastructure with an availability
  obligation; its anchoring interval bounds the rewritable tail and is
  disclosed in attestation reports.
- Sessions are the chaining unit, so cross-session claims (fleet aggregates)
  derive their integrity from checkpoint inclusion, not from a single chain.
