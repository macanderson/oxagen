# ADR-040: Refocus Oxagen as an engine-agnostic governance plane

- **Status:** Accepted
- **Date:** 2026-08-29
- **Owners:** platform
- **Related:** `docs/specs/governance-plane-refocus/review.md` (the
  full-codebase review this ADR ratifies, merged in #1443), issue #1444
  (execution tracking), ADR-033 (Stella engine core — the engine seam),
  ADR-024 (namespaced agent identity), ADR-035/ADR-036 (Context Graph
  Protocol consumption), `docs/specs/run-evidence-ingress/spec.md`
  (Approved — the external-evidence seam)

## Context

Oxagen's vision has always been the governed control plane — the enforced
accountability chain of identity → knowledge scope → permitted action →
commercial terms → verified outcome → audit record. But the monorepo also
carries a full first-party agent *runtime*: `agent-engine` (the coding loop),
`agent-worker`, `sandbox`, `skills`, `replay`, `bench`, `prompt-templates`,
and the CLI's execution core. That runtime is not the product. Stella (the
Rust agent, ADR-033) and arbitrary third-party agents are the agents; Oxagen
governs them.

The governance-plane refocus review (`docs/specs/governance-plane-refocus/`)
established that the runtime is cleanly separable: `agent-engine` has zero
`@oxagen/*` dependencies, every chat surface converges on one 61-line
delegation seam (`packages/agent-runner/src/execute-turn.ts`), and the
external-agent governance spine already exists — `run-evidence` (CGP
conformance + tamper-evident digests), `stella-engine-client` (external
engine transport), the Stella telemetry ingress, A2A, and
`authorizeExternalCapability()`.

## Decision

**Oxagen is a governance plane for any agent, not an agent platform.**

1. **The kernel is the product.** `invoke()` with IAM → billing admission →
   entitlement → approval gates, metering→Stripe, ClickHouse audit, graph
   grounding, and run-evidence attestation are the load-bearing assets.
2. **The in-process agent runtime is extracted or deleted**, per the review's
   keep/extract/delete disposition: `agent-engine`, `agent-worker`,
   `sandbox`, `skills`, `code-graph` extract to the engine product;
   `bench`, `replay`, `prompt-templates` are deleted; `agent-runner` stays
   (it is the run-identity/attestation store, not a runner) after its
   `execute-turn.ts` seam is repointed at an external engine.
3. **External agents are governed through evidence + gateway, not embedding.**
   The `run-evidence-ingress` spec's `ingest_run_evidence` capability
   (`runner_observed` for hosted execution, `client_attested` for standalone
   agents) and a transport-neutral governed tool gateway (generalizing
   `packages/agent/src/runtime/` and `authorizeExternalCapability()`) are the
   wrapper that makes any agent observable, permission-requesting, and
   CGP-conformant.
4. **Governance-plane strength claims are honest.** Gateway-enforced controls
   (tool calls through the kernel) are enforcement; `client_attested`
   evidence is attestation, not enforcement, and is always labeled as such.

Execution is phased in issue #1444; the evidence-ingress metering path must
land before the in-process engine is removed, or billing attribution goes
dark.

## Consequences

- `docs/VISION.md` is amended so external-agent governance work — evidence
  ingress, the governed tool gateway, third-party agent identity, wrapper
  SDKs — reads as advancing the wedge rather than drifting from it.
- Roughly 20k LOC of runtime packages and the execution-oriented app routes
  leave this repo over the Phase 1 window; the approvals/audit/fleet UI is
  extracted from the chat surface rather than deleted with it.
- New capabilities continue to land as typed contracts with full parity;
  nothing in this refocus weakens capability parity, metering, or the
  four-store boundaries.

## Alternatives considered

- **Keep the first-party runtime as a flagship surface.** Rejected: it
  competes where the vision explicitly declines to fight (framework
  mindshare), and its maintenance cost starves the governance wedge.
- **Delete the runtime without an external seam first.** Rejected: removing
  `executeTurn` before evidence-ingress metering lands breaks the
  metering→billing loop for chat, the flagship governed workload.
