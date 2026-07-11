# 10 Moonshot Ideas: Making the Oxagen CLI the Most Accurate & Performant Coding Agent

**Date:** July 10, 2026
**Context:** Web-researched against the mid-2026 state of the art. Key landscape facts as of this week: Claude Fable 5 / Mythos 5 sit at ~95% on SWE-bench Verified, so the model is no longer the differentiator — **the harness is** (the same GPT-5.5 swings 7 points on Terminal-Bench 2.1 depending on the wrapping loop). Frontier themes: hash-anchored/AST editing, agent-drivable debuggers, hours-long autonomous loops, knowledge-graph codebase memory (10× fewer tokens at near-parity quality), multi-verifier test-time compute (CMU showed naive scaling has a ceiling — the "verification gap"), and observability-driven *automatic harness evolution*.

The through-line: Oxagen's four-store architecture accidentally built the ideal substrate for all of this. ClickHouse traces are training data for the harness, Neo4j is long-term memory, sandboxes are cheap parallel universes, and contracts make every mechanism governed by construction.

---

## 1. The bi-temporal code-fact graph that *learns from every session*

Everyone now indexes repos into knowledge graphs (tree-sitter GraphRAG tools index the Linux kernel in 3 minutes, answer at 10× fewer tokens). Nobody makes the graph **learn**. Oxagen already has bi-temporal fact edges (valid-time + transaction-time, PR #563) and local code-graph embeddings.

The crazy part: every *verified* discovery an agent makes mid-session — "this function is the auth chokepoint," "this test is flaky under Node 26," "this config is dead since commit X" — gets written back as a cited, time-scoped fact with provenance. The 1,000th session on a repo starts with everything the previous 999 proved, and facts *expire* when the code that grounded them changes (the bi-temporal machinery closes them instead of deleting).

No competitor has a fleet-wide, time-aware, self-enriching codebase memory — they all re-derive the repo from scratch or serve a stale static index.

## 2. The self-evolving harness: mine ClickHouse traces, auto-patch the loop

There is a 2026 arXiv line of work on "observability-driven automatic evolution of coding-agent harnesses" — and Oxagen is the only product whose telemetry is already *built for it* (every LLM call metered with prompt hashes, durations, surface tags).

A nightly optimizer mines the trace lake for failure motifs: edit-retry loops, planner over-calls on simple prompts, wrong-file reads after specific grep patterns, tool descriptions that correlate with malformed calls. It then proposes harness patches — prompt tweaks, tool-doc rewrites, routing-threshold changes, new deterministic fast-paths — validates each candidate against the evals-v1 metered-trace datasets, and ships winners behind a flag.

The harness literally gets better every night from its own production exhaust. Since harness quality is now worth ~7 benchmark points at fixed model, this compounds into a moat nobody can copy without the metering loop.

## 3. Speculative tool execution — speculative decoding, one level up

Speculative decoding is everywhere in 2026 inference (Mirror-SD, SSD, 5.8× speedups); nobody has ported the idea to the *agent loop*.

While the frontier model is still thinking, a tiny local draft model (Oxagen already ships local ONNX/Ollama for embeddings) predicts the next 2–3 tool calls — "it will read `auth.ts`, then grep for `rateLimits`, then run this test file" — and executes them speculatively into a result cache. When the big model emits the actual call, the result is already sitting there; mispredictions are discarded.

Extend it to infrastructure: pre-warm the sandbox, pre-run the likely test file, prefetch the code-graph neighborhood of every file mentioned in the prompt. Perceived latency drops toward zero on the read-heavy ~70% of agent turns.

## 4. Un-poisonable edits: hash-anchored, AST-applied, typecheck-delta gated

Hash-anchored editing (patches anchored to content hashes so whitespace drift can't misplace them) is the mid-2026 state of the art. Go further and make **every edit a capability contract**: anchored by content hash, applied as an AST transform where possible, and gated by a *typecheck delta* — the harness snapshots diagnostics before and after, and an edit that introduces new diagnostics is auto-rejected unless the agent explicitly declared "this will break until step 4."

Each edit lands in the lineage graph with its anchor, its diagnostic delta, and the turn that produced it. This is Oxagen's typed-contract wedge applied to the file system itself: identity → permitted action → verified outcome → audit record, per edit. Torn/misapplied patches — still the #1 silent killer of agent accuracy — become structurally impossible.

## 5. Tournament mode: budget-priced best-of-N sandbox rollouts, winner by executed tests

Oxagen's own SWE-bench work already proved best-of-5 cross-family with auto-verification by executed tests beats single-shot quality, and the harness runs single-shot at $0.49/task.

Productize the ensemble: on turns the triage model marks risky, silently fork N rollouts across persistent sandboxes/worktrees (the fleet fan-out and `agent.subagent.dispatch` lineage already exist), possibly across model families, and let *executed tests* — not an LLM judge — pick the winner. The user only ever sees the winning diff, with the losers in the lineage graph for audit. The per-turn USD budget decides N dynamically: `+$2` buys a 5-way tournament.

This directly attacks the CMU "verification gap" finding — parallel test-time compute only works with a real verifier, and executed tests are the one verifier that doesn't hallucinate.

## 6. The mutation verifier: prove every test fails without its fix

"Verify tests pass for the RIGHT reason" — automate it as a physical law of the harness.

After the agent produces fix + test, the harness **reverts the fix in a shadow sandbox and re-runs the test — if it still passes, the test is vacuous and the turn is rejected** before the user ever sees a false green. Second layer: LLM-guided mutation testing of just the changed region (mutate the patch, measure the kill rate) to score test adequacy and gate merges on it.

No agentic CLI on the market verifies that its tests *witness* the fix; this single check eliminates the most embarrassing failure class in agentic coding — confidently shipped no-op fixes.

## 7. Time-travel replay: every production failure becomes an eval, automatically

The envelope-v1 event log (ADR-023) already replays from seq 1. Push it to full determinism: record every tool I/O and snapshot sandbox FS layers so any run can be re-executed bit-for-bit, **bisected across steps** ("which turn doomed this run?"), and *resumed from any step with a different model, prompt, or harness version*.

Then close the loop: every failed or thumbs-downed run auto-distills into an evals-v1 case, so the nightly optimizer (idea #2) trains against the exact failures users actually hit. Competitors debug their agents by vibes and anecdotes; Oxagen would debug them like a database — with a WAL and point-in-time recovery.

## 8. Debugger-in-the-loop: stop println-guessing, start stepping

The 2026 reviews name "a debugger the agent can drive" as a frontier feature — almost nobody ships it. Oxagen's Modal sandboxes can expose the Debug Adapter Protocol as capability contracts: `debug_set_breakpoint`, `debug_step`, `debug_inspect_frame`.

On a failing test, the harness runs it once under a coverage/call tracer and feeds the *actual executed path* into context — replacing the grep-and-guess ritual that burns thousands of tokens on wrong hypotheses — then lets the agent set breakpoints and inspect live values where the trace diverges from expectation.

Debugging tasks are where the remaining ~5% of SWE-bench lives; grounding in real runtime state instead of static reads is how you take them. And because it's contract-shaped, every debugging session is metered, governed, and auditable like everything else.

## 9. Trace macros: compile the fleet's successful workflows into deterministic fast paths

Oxagen already replaced an NL-resolver with harness determinism (PR #875) and classifies simple prompts onto fast paths (PR #654). The crazy generalization: cluster successful traces in ClickHouse by semantic task signature ("add a zod schema + handler + route for X", "bump a coverage ratchet", "wire a new connector"), and **compile recurring clusters into parameterized deterministic macros** — replayable tool sequences with typed holes, verified by the same executed-test gate.

Next time the task signature matches, the macro runs at machine speed with the LLM only filling holes and reviewing the result. It's the semantic AI cache (exact+semantic, PR #560) lifted from *responses* to *whole workflows*. Skills that today get hand-written become artifacts the platform mines automatically — an agent that visibly gets faster at your codebase's idioms every week.

## 10. The verified-outcome market router — accuracy with an SLA and a price tag

Per-function model routing exists (`/triage-model`, `/judge-model`, `/worker-model`); make it *learned and economic*. Every subtask class gets a live cost/accuracy Pareto curve computed from Oxagen's own ClickHouse history (verified successes per model per task signature, at current AI Gateway prices). The router then treats each subtask like an order routed to the cheapest venue that clears the verified-success threshold — re-fitting continuously as prices and models drift, escalating tiers only when the verifier (ideas #5/#6) rejects.

The endgame, and the pure Stripe-for-agents move nobody else can make: **billing-native accuracy SLAs** — "this task class: ≥95% verified success at ≤$0.50, or the credits are refunded automatically," enforced by the same metering→Stripe loop that bills it. Accuracy stops being a vibe and becomes a priced, guaranteed, auditable product.

---

## Composition notes

- Ideas #5 + #6 compose into something genuinely rare: parallel test-time compute whose verifier is *ground-truth execution plus mutation witness*, not an LLM judge judging an LLM — sidestepping both failure modes the CMU paper identified.
- #10 is a business-model innovation disguised as an engineering feature: nobody can offer refund-backed accuracy SLAs without owning the metering→billing loop, which is exactly the wedge in `docs/VISION.md`.

## Suggested sequencing (leverage-to-effort)

1. **#6 Mutation verifier** — smallest build, immediately kills false greens.
2. **#3 Speculative tool execution** — the biggest *felt* performance win.
3. **#1 Learning code-fact graph** and **#2 Self-evolving harness** — the compounding moats; worth a quarter.

## Sources

- [State of CLI Coding Agents, Mid-2026](https://blog.arcbjorn.com/state-of-cli-coding-agents-2026)
- [Best CLI AI Coding Agents in 2026 — DevToolLab](https://devtoollab.com/blog/top-cli-ai-coding-agents)
- [SWE-bench Verified — BenchLM.ai July 2026](https://benchlm.ai/benchmarks/sweVerified)
- [SWE-bench Verified — vals.ai](https://www.vals.ai/benchmarks/swebench)
- [Terminal-Bench 2.1 and the June 2026 Benchmark Landscape](https://codex.danielvaughan.com/2026/06/11/terminal-bench-2-1-june-2026-benchmark-landscape-codex-cli-harness-engineering-model-scores/)
- [Agent harness engineering — explainx.ai](https://explainx.ai/blog/agent-harness-engineering-terminal-bench-langchain-2026)
- [Agentic Harness Engineering: Observability-Driven Automatic Evolution (arXiv)](https://arxiv.org/pdf/2604.25850)
- [Benchmark Test-Time Scaling of General LLM Agents (arXiv)](https://arxiv.org/abs/2602.18998)
- [Multi-Agent Verification (arXiv)](https://arxiv.org/pdf/2502.20379)
- [To Run or Not to Run: Cost-Effectiveness of Code Execution in Program Repair (arXiv)](https://arxiv.org/html/2606.26978)
- [Persistent Codebase Memory — Cognee](https://www.cognee.ai/blog/guides/ai-coding-agent-persistent-codebase-memory)
- [codebase-memory-mcp: 99% fewer tokens](https://toknow.ai/posts/codebase-memory-mcp-knowledge-graph-99-fewer-tokens/)
- [The Agent Memory Race of 2026 — OSS Insight](https://ossinsight.io/blog/agent-memory-race-2026)
- [Codebase-Memory: Tree-Sitter Knowledge Graphs (arXiv)](https://arxiv.org/html/2603.27277v1)
- [JetSpec: Parallel Tree Drafting (arXiv)](https://arxiv.org/html/2606.18394v2)
- [Speculative Speculative Decoding — ICLR 2026](https://openreview.net/pdf?id=aL1Wnml9Ef)
- [Claude Code vs Codex vs Gemini CLI 2026 — IntuitionLabs](https://intuitionlabs.ai/articles/claude-code-vs-codex-vs-gemini-cli-comparison)
