# Oxagen CLI: Accuracy & Performance Roadmap

**Date:** July 10, 2026
**Companion to:** [`agentic-cli-moonshots-2026-07-10.md`](./agentic-cli-moonshots-2026-07-10.md) (the 10 researched ideas this roadmap sequences)
**Slide deck:** `/decks/agentic-cli-roadmap` on docs.oxagen.sh (`apps/docs/public/decks/agentic-cli-roadmap/`)

## Framing

As of this week, frontier models have converged at ~95% on SWE-bench Verified. Harness quality is now worth ~7 Terminal-Bench points at fixed model, and CMU's test-time-scaling work shows the binding constraint is **verifier quality**, not compute. Oxagen's four stores (ClickHouse traces, Neo4j bi-temporal graph, typed contracts, disposable sandboxes) are precisely the substrate a winning harness needs. This roadmap sequences the 10 moonshot ideas by leverage-over-effort into four phases.

## What we have today (the baseline)

| Asset | Status |
|---|---|
| SWE-bench harness, single-shot, executed-test verification | Shipped; ~$0.49/task, beats Claude Code head-to-head |
| Fleet fan-out with lineage (`agent.subagent.dispatch`) | Shipped |
| Per-turn USD budgets + per-function model routing (`/triage-model`, `/judge-model`, `/worker-model`) | Shipped (PRs #625, #659) |
| Deterministic fast paths + simple-prompt classifier | Shipped (PRs #654, #875) |
| Local code-graph embeddings (ONNX/Ollama, byte-compat push skip) | Shipped |
| Persistent per-turn sandboxes with reaper + honest lifecycle | Shipped (PRs #789, #829, #831) |
| Scope-review gate, Mission Control event log (ADR-023 envelope v1) | Shipped (PRs #661, #664) |
| Agent memory recall (MemoryProvider) | Shipped (PR #437) |
| Evals v1 (metered-trace datasets + LLM judge) | Shipped (PR #569) |
| AI response cache (exact + semantic) + Batch API | Shipped (PR #560) |
| Bi-temporal fact edges (valid time + transaction time) | Shipped (PR #563) |

## Phase 1 — Verified Green (weeks)

**Goal: never ship a false green again.** Accuracy floor before accuracy ceiling.

| Item | Moonshot | Scope |
|---|---|---|
| Mutation verifier | #6 | Shadow-sandbox revert of the fix; test must fail without it or the turn is rejected. Layer 2: LLM-guided mutation of the changed region, gate on kill rate. |
| Un-poisonable edits | #4 | Content-hash-anchored patches, AST-applied where possible, typecheck-delta gate (new diagnostics auto-reject unless declared). Every edit recorded in lineage. |

**Dependencies:** existing sandbox infra; typecheck snapshot tooling.
**Success metrics:** vacuous-test rejection rate > 0 in production (proves it catches real cases); misapplied-patch incidents → 0; no measurable latency regression on the happy path (shadow verify runs off the critical path).

## Phase 2 — Feels Instant (this quarter, Q3 2026)

**Goal: hide latency with speculation; ground debugging in runtime truth.**

| Item | Moonshot | Scope |
|---|---|---|
| Speculative tool execution | #3 | Local draft model predicts next 2 to 3 tool calls during frontier-model thinking; speculative execution into a result cache; sandbox pre-warm; likely-test pre-run; code-graph neighborhood prefetch. |
| Debugger-in-the-loop | #8 | DAP as capability contracts (`debug_set_breakpoint`, `debug_step`, `debug_inspect_frame`); failing test runs once under a coverage/call tracer; executed path fed into context. |

**Dependencies:** local ONNX/Ollama runtime (exists); Modal sandbox runner changes (remember: runner deploy drift, deploy `ops/modal-sandbox`).
**Success metrics:** tool-call cache hit rate ≥ 40% on read-heavy turns; p50 perceived read latency cut by half; debugging-task solve rate up measurably on the evals debugging slice.

## Phase 3 — Compounding Memory (Q4 2026)

**Goal: the 1,000th session on a repo starts smarter and faster than the 1st.**

| Item | Moonshot | Scope |
|---|---|---|
| Learning code-fact graph | #1 | Verified mid-session discoveries written back as cited, time-scoped facts with provenance; bi-temporal expiry when grounding code changes; recall at session start. |
| Time-travel replay | #7 | Record all tool I/O + sandbox FS layer snapshots; bit-for-bit re-execution; step bisection; resume-from-step with different model/prompt; failed runs auto-distill into evals-v1 cases. |
| Trace macros | #9 | Cluster successful ClickHouse traces by semantic task signature; compile recurring clusters into parameterized deterministic macros with typed holes, verified by the executed-test gate. |

**Dependencies:** envelope v1 event log (exists); bi-temporal edges (exist); ClickHouse trace schema (exists).
**Success metrics:** session-N-vs-session-1 solve-rate and token-cost deltas on repeat repos; ≥ 10 mined macros in production use; every thumbs-down run present in the evals dataset within 24h.

## Phase 4 — The Economic Moat (H1 2027)

**Goal: accuracy becomes a priced, guaranteed, auditable product.**

| Item | Moonshot | Scope |
|---|---|---|
| Self-evolving harness | #2 | Nightly optimizer mines trace lake for failure motifs; proposes harness patches (prompts, tool docs, routing thresholds, new fast paths); validates against evals; ships behind flags. |
| Tournament mode | #5 | Budget-priced best-of-N sandbox rollouts on risky turns, optionally cross-family; executed tests pick the winner; losers kept in lineage for audit. |
| Verified-outcome market router + SLAs | #10 | Live cost/accuracy Pareto per task class from own ClickHouse history at current gateway prices; route to cheapest model clearing the verified-success threshold; refund-backed accuracy SLAs enforced by the metering→Stripe loop. |

**Dependencies:** Phases 1 to 3 (the verifier stack is what makes tournaments and SLAs honest); evals coverage per task class; billing-grant plumbing for refunds.
**Success metrics:** harness-optimizer patches with measured eval lift shipped weekly; tournament turns clearing verification ≥ 95%; first task class offered under a refund-backed SLA.

## Why this matters (the wedge)

- **Verification gap:** parallel test-time compute only works with a real verifier. Executed tests + mutation witnesses are ground truth, not an LLM judging an LLM. Phases 1 and 4 compose into exactly that.
- **Harness flywheel:** nobody can copy the self-evolving harness without owning the metering loop; nobody can copy the learning graph without the bi-temporal store; nobody can offer refund-backed SLAs without the billing loop. Each phase deepens a `docs/VISION.md` pillar (verified outcome, graph grounding, metering→billing).
- **Positioning:** "accuracy you can invoice" is a claim no competitor's architecture allows them to make.

## Risks & mitigations

- **Speculation waste** (idea #3 burning sandbox/compute on mispredictions): cap speculative depth at 3 calls, meter speculative spend separately, kill-switch flag.
- **Graph pollution** (idea #1 writing back wrong facts): only *verified* discoveries (executed evidence) become facts; provenance mandatory; bi-temporal supersede, never delete.
- **Harness self-patch regressions** (idea #2): eval-gated, flag-shipped, auto-revert on live-metric regression.
- **SLA exposure** (idea #10): start with narrow, well-measured task classes; price from own historical variance; refunds in credits first.
