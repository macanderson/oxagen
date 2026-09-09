# Tacho — the agent flight recorder

`spec.md` (Proposed, 2026-09-06) is the Oxagen contract: `@oxagen/tacho`, the
wrapper for every agent Oxagen does not run itself — Claude Code through hooks,
Claude Agent SDK agents in-process, custom agents through `tacho.wrap(...)` —
with one enrollment contract, one evidence contract and one control contract
that Stella meets natively. `plan.md` sequences the build; `design/` is the
product design (trace model, approval tokens, trust scoring, threat model,
insurer API, and its three decision records `adr-0003..0005`).

## The Stella-side seam corpus (copied)

The remaining files in this directory are copied verbatim from
`macanderson/stella` at commit `0cb26c5e0835aa79e70674d723575871c5ca52fd`
(`docs/spec/*`) on 2026-09-07. Stella is the reference implementation of the
Context Graph Protocol and of the trace vocabulary `spec.md` §6 ingests; these
documents define the seam Stella already speaks. They are copied, not linked,
so both sides of the contract are versioned in the repository that implements
the Oxagen half. When Stella revises one, re-copy and bump the commit above.

| File | What it defines | `spec.md` consumer |
|---|---|---|
| `oxagen-trace-drain.md` | Full-fidelity egress: `AgentEvent` journal → content-bearing drain → Oxagen's three storage planes, column-level mapping | §6 evidence contract, `ingest_run_evidence` |
| `session-telemetry-receipts-spec.md` | Per-session receipts: what was sent to the model, tool-call preimages, digests | evidence manifests, replay grade |
| `enterprise-authority-telemetry.md` | Authority model (managed ceiling ∩ repo trust ∩ session grant), content-free rollup, signed enrollment | §5 enrollment, IAM delegation ceiling |
| `witness-protocol.md` | The flip oracle (fail→pass of the same normalized command), tamper exclusion, deterministic-first ladder | the trace-level pass/fail stamp |
| `verification-gate.md` | `Completed` vs failed/aborted/indeterminate | outcome on execution records; trust input |
| `step-grading-and-productive-ratio.md` | Per-step grading and the productive ratio | `design/trust-scoring.md` |
| `wrapper-socket.md` | The plugin socket a turn-loop wrapper plugs into | `design/examples/rust-stella.md` |
| `agent-monitor-protocol.md` | One JSON line per detection from any run watcher to any supervisor | fleet monitor ingress |
| `serve-observability.md` | What `stella serve` exposes for observation | §7 control contract (reverse-RPC tier) |

Oxagen's ledger side of this seam is `docs/specs/run-evidence-ingress/spec.md`
(Approved) and `@oxagen/run-ledger`; the excision that made the wrapper the
only agent surface is ADR-043.
