# Agent Engine V2 — Stella core, Oxagen governance

**Status:** proposed (see ADR-033). **Owner:** Mac Anderson.

The platform's agent engine gets its upgrade by adopting the
[Stella](https://github.com/macanderson/stella) Rust engine core
(`stella-protocol` + `stella-core` + `stella-serve`, MIT OR Apache-2.0) as
the turn driver — driven as a loopback sidecar from a durable worker — while the
capability kernel, sandbox, engram, approvals, and billing remain sovereign and
implement the engine's ports. Every tool call the engine dispatches still
re-enters `kernel.invoke()`.

Two things in that sentence changed after this spec was written, and the
original wording survives in `spec.md`'s older sections:

- **`stella-pipeline` no longer exists.** Upstream deleted the built-in staged
  verification pipeline (stella#3865); verification there is now an installed
  plugin whose evidence is self-reported. Nothing in this spec's verification
  plane can assume a host-run oracle.
- **The binding is a sidecar, not napi.** `stella-serve` over loopback replaced
  the `stella-engine-node` napi binding this spec assumed. See
  [`plan.md`](./plan.md) § "Phase 3" for why — stella's process-global
  credential state makes one engine process per worker slot the containment
  boundary.

- [`spec.md`](./spec.md) — the full design: current-state audit (with
  file:line evidence), the Stella reference bar, options analysis, target
  architecture, port mapping, durable runner, verification plane (witness +
  flip oracle + ladder), hook bus as the plugin policy surface, keep/retire
  table, upstream work items, risks.
- [`plan.md`](./plan.md) — phased rollout with exit criteria: Phase 0 quick
  wins (code_graph speculation, guarded tool parallelism) → single
  `executeTurn()` seam → durable runs → embedded core behind a flag → ladder +
  bus in production → consolidation.
- [`../../adr/ADR-033-stella-engine-core.md`](../../adr/ADR-033-stella-engine-core.md)
  — the decision record.

Supersedes `docs/specs/oxagen-rust-cli/` on the "build a Rust agent" point:
that agent was built — it is Stella — and this spec brings its core into the
platform instead of porting the platform into a CLI.
