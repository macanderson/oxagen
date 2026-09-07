# Tacho — the agent flight-recorder corpus

**Provenance.** Copied verbatim from `macanderson/stella` at commit
`0cb26c5e0835aa79e70674d723575871c5ca52fd` (`docs/spec/*`) on 2026-09-07.
Stella is the reference implementation of the Context Graph Protocol (CGP)
and of the trace vocabulary Oxagen governs; these documents define the seam
Stella already speaks and Oxagen must ingest. They are copied, not linked, so
the Oxagen side of the seam is versioned in the repository that implements
it. When Stella revises one, re-copy and bump the commit above.

**No document literally named "tacho" exists in any Stella repository this
audit could reach** (`macanderson/stella`, `stella-proving-ground`,
`stella-engine-proof`). "Tacho" (tachograph — the tamper-evident recorder
mandated in commercial vehicles) is the working name for the design these
files describe together: a content-bearing, consent-gated, tamper-evident
drain of every agent execution down to individual tool-call I/O, stamped
with a fail/pass oracle verdict at the trace level. If a `tacho.md` design
doc exists outside git, drop it in this directory.

| File | What it defines | Oxagen consumer |
|---|---|---|
| `oxagen-trace-drain.md` | The full-fidelity egress: `AgentEvent` journal → content-bearing drain → Oxagen's three storage planes, with column-level mapping | `ingest_run_evidence` / evidence ledger (`@oxagen/run-ledger`) |
| `session-telemetry-receipts-spec.md` | Per-session receipts: what was sent to the model, tool-call preimages, digests | evidence manifests, replay grade |
| `enterprise-authority-telemetry.md` | Authority model (managed ceiling ∩ repo trust ∩ session grant), content-free operational rollup, signed enrollment | `create_stella_enrollment`, `ingest_stella_operational_telemetry`, IAM delegation ceiling |
| `witness-protocol.md` | The flip oracle (fail→pass of the same normalized command), tamper exclusion, deterministic-first ladder | The trace-level pass/fail stamp that replaces human labelling for self-improvement |
| `verification-gate.md` | The gate that decides `Completed` vs failed/aborted/indeterminate | outcome column on execution records; trust score input |
| `step-grading-and-productive-ratio.md` | Per-step grading and the productive ratio metric | agent performance rating / trust gates |
| `wrapper-socket.md` | The plugin socket that wraps a turn loop — the shape an Oxagen wrapper SDK plugs into | wrapper SDK (Phase 2 of ADR-040) |
| `agent-monitor-protocol.md` | One JSON line per detection from any run watcher to any supervisor | fleet monitor ingress |
| `serve-observability.md` | What `stella serve` exposes for observation | governed gateway transport |

Oxagen's own side of this seam is `docs/specs/run-evidence-ingress/spec.md`
(Approved) and ADR-041.
