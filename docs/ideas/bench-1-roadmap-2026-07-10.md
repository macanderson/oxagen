# Bench #1, With Receipts: Validated Roadmap for the Ten Moonshots

**Date:** July 10, 2026
**Companion to:** `agentic-cli-moonshots-2026-07-10.md` (the source ideas)
**Presentation:** published as a Claude artifact ("Bench #1, with receipts · Oxagen strategy")
**Method:** five independent adversarial research passes (repo memory + macros, harness evolution + routing, speculative execution + replay, edit integrity + mutation verification, benchmark meta), each instructed to find the counterexample to every "nobody does this" claim. SEO-farm leaderboard numbers were discarded unless corroborated by a primary source.

---

## The landscape shifted under the original doc

Three findings from this pass change the framing:

1. **Harness value is larger than claimed.** The source doc said harness quality is worth ~7 points at a fixed model. The evidence says 20 to 35+: three systems on identical Claude Opus 4.5 spread 5.2 points on scaffold alone (SWE-bench Pro), automated harness evolution lifted a fixed GPT-5.4 from 69.7% to 77.0% on Terminal-Bench 2 (arXiv:2604.25850), Darwin Godel Machine went 20% to 50% on SWE-bench by self-modifying the harness (arXiv:2505.22954), and an applied case study went 34% to 71% without a model upgrade.
2. **SWE-bench Verified is dead as a target.** OpenAI retired it in February 2026 (frontier models reproduce gold patches from the task ID alone; ~59% of failed problems had broken tests). SWE-bench Pro was audited July 8, 2026 and found ~30% broken. Credible boards: **Terminal-Bench 2.1** (Codex CLI 83.4%, Claude Code 78.9%), **SWE-rebench**, **SWE-bench-Live**. "Bench #1" means #1 on boards that will still be credible in 2027.
3. **Trust is the second axis.** Cursor's audit of 731 SWE-bench Pro trajectories found 63% of "successful" resolutions retrieved the fix from public sources; isolating that channel dropped the top model 87.1% to 73.0%. Post-scandal, a provably clean, replayable, auditable score is itself a differentiator, and Oxagen's whole architecture (lineage, contracts, metering) is built for it.

## Scoreboard after adversarial review

| # | Idea | Diff. | Closest competitor (cited) | What survives as ours | Phase |
|---|---|---|---|---|---|
| 1 | Learning code-fact graph | 3/5 | GitHub Copilot Agentic Memory: file+line-cited observations, repo-wide, re-verified on recall, 28-day TTL (kenmuse.com). Graphiti: bi-temporal formalism, no code awareness (arXiv:2501.13956) | The synthesis: bi-temporal typed edges, **git-diff-driven expiry (not TTL)**, fleet-wide, as-of-commit queries. Temporal restriction on recall so memory never reads as contamination | P2 |
| 2 | Self-evolving harness | 2/5 | Named subfield "Agentic Harness Engineering" (arXiv:2604.25850, 2606.09498, 2605.09998); LangSmith Engine ships trace-cluster → diagnose → draft PR → eval with named customers | Not the concept, the substrate: evolution mined from the same ClickHouse store that bills; autonomous flag-gated ship. **Eval gate immutable to the optimizer** (DGM reward-hacked its own loop) | P2 |
| 3 | Speculative tool execution | 2/5 | PASTE (arXiv:2603.18897): pre-warms sandboxes, prefetches files, pre-runs tests on coding workloads, 43.5% task-time cut. 7+ papers; zero products | First-to-ship, local ONNX/Ollama draft models. Rule: speculate only on read-only sandbox-local ops (Ghost Tool Calls, arXiv:2606.02483: discarded branches still leak/bill) | P3 |
| 4 | Verified edits (renamed from "un-poisonable edits") | 3/5 | Hive shipped content-hash "hashline" anchoring; open ask on Codex CLI #12987, closed not-planned on Claude Code #25775; ast-grep/Serena commoditize AST edits | The **typecheck-delta gate with declared-break override** and the **per-edit lineage record** (anchor, diagnostic delta, producing turn). Soften "#1 silent killer" to "one of the largest and most fixable" (single-source evidence: blog.can.ac) | P1 |
| 5 | Tournament mode | 4/5 | Cursor 2.2 multi-agent judging: same UX, **LLM judge** selector; CMU verification gap shows judge selection plateaus ~55% (arXiv:2602.18998). Trae 75.2%/Devlo 70.2% use execution selection but only in benchmark scaffolding | Silent execution-verified tournaments with dollar-elastic N. SWE-bench rules bless it as Best@k. Bonus: the execution-vs-judge ablation at agentic scale is unpublished; we run and publish it | P1 |
| 6 | Mutation verifier | 4/5 | The mechanic is SWE-bench's own FAIL_TO_PASS (public since 2023); no product runs it live per-turn (surveyed: Devin, Copilot, Cursor, Aider, CodeRabbit, Qodo, Greptile, SWE-agent). Meta ACH proves mutation-guided testing at scale, but as bulk campaigns | The live per-turn vacuity gate + mutation-scored merges. Thin mechanism moat; defense is composition (it is the tournament's integrity layer and the SLA's trust layer). No direct bench-point evidence yet: measure in P1 | P1 |
| 7 | Time-travel replay | 4/5 | Primitives solved separately: rr, Antithesis, Temporal, LangGraph time travel (re-executes live, does not replay recorded I/O), Braintrust (manual trace-to-eval). Nobody bundles all six; nobody auto-distills failures to evals | The full bundle on envelope-v1 + Modal FS snapshots. Also the proof-of-score instrument: a replayable run is a receipt | P2 |
| 8 | Debugger-in-the-loop | 2/5 | JetBrains Junie GA (June 17, 2026) ships agentic DAP debugging; Pointbreak pitches it verbatim; DAP MCP servers commoditized. Counter-evidence: removing execution access costs SOTA agents only 1.25pp, ns (arXiv:2606.26978): agents over-execute already | Only the **two-phase workflow**: coverage/call trace localizes the divergence, then targeted breakpoints. Localization is where 40 to 67% of failures live (SHERLOC +5.95pp, arXiv:2606.24820). No bare DAP tool surface | P2 |
| 9 | Trace macros | 4/5 | Skill-DisCo (arXiv:2606.26669): exact mechanism (cluster → typed-hole compile → held-out verify), non-coding domains only. CODESKILL (arXiv:2605.25430): coding-domain mining on SWE-bench (+9.69%) but NL skills only, executables = their future work | The coding-domain synthesis. **6-to-12-month window** before a lab closes it. Trap flagged by a negative result: cluster on semantic task signatures, not raw action vectors | P2 mine / P3 ship |
| 10 | Verified-outcome market router | 4/5 | All routers train on preference/judge data (RouteLLM, NotDiamond, Martian); PROTEUS = latency/cost SLA only; Sierra/Fin/Zendesk = per-event outcome billing, no statistical floor, no auto-refund; Metronome (now Stripe) meters without accuracy semantics | The whole loop: verified-outcome Pareto routing + refund-backed accuracy SLA through our metering→Stripe pipe. Constraint: verifier coverage, so first SLA on test-verifiable classes only | P3 |

Differentiation: 5 = unclaimed space · 4 = unclaimed combination · 3 = narrow gap, fast-follow risk · 2 = crowded, angle only. Nothing scored below 2; nothing needs killing; four need repositioning (2, 3, 4, 8).

## The bench-#1 argument

Evidence-ranked levers at a fixed model:

1. **Execution-selected Best@k (idea 5):** +3 to 8pp measured from ensembling (Augment); built Trae's SOTA and Devlo's 70.2%; legal under SWE-bench Best@k rules; Cursor's shipped alternative (LLM judge) has a proven ~55% ceiling.
2. **Harness evolution (idea 2):** +7.3pp at fixed model over 10 iterations, transfers across benches (arXiv:2604.25850); mini-swe-agent (100 lines) beating feature-heavy harnesses is the same lesson from the other side.
3. **Graph-grounded localization (idea 1):** +5.95pp analog (SHERLOC) while cutting tokens 23 to 37%; failure taxonomies put 40 to 67% of agent failures on localization/diagnosis, not code writing.
4. **Edit integrity (idea 4):** up-to-10x task-level swings from the edit interface alone, single-source; we re-measure in P1.
5. **Trace-first debugging (idea 8):** +30 to 182% relative in the lab (debug-gym), capped by model skill; targeted beats blanket.
6. **Mutation gate (idea 6):** unmeasured on benches, but protects lever 1 from vacuous greens and the brand from reward-hacking headlines.

Gains overlap and do not sum, but the evidence supports a double-digit compound lift at a fixed model: the distance between mid-pack and #1 on Terminal-Bench 2.1.

**The receipts are the second product.** Every submitted run replayable (7), every edit audited (4), every test proven non-vacuous (6), memory temporally restricted (1). The first agent whose score you can audit. Nobody else owns the loop required to even attempt the claim.

## Roadmap

### Phase 1 · The verified core · Q3 2026 (6 to 8 weeks)
- **Idea 6 L1** — shadow-sandbox fail-to-pass gate on every fix+test turn (substrate: PR #789 sandbox lifecycle, worktrees).
- **Idea 4** — hashline anchors + typecheck-delta gate + per-edit lineage record (substrate: lineage graph, PR #874/#877 file tooling).
- **Idea 5** — productize fleet fan-out with executed-test selection and budget-elastic N (substrate: `agent.subagent.dispatch`, PR #625 budgets, internal best-of-5 result at $0.49/task single-shot).
- **Milestone:** Terminal-Bench 2.1 + SWE-rebench submissions; publish the execution-vs-judge ablation; measure each gate's point contribution.

### Phase 2 · The learning loop · Q4 2026
- **Idea 7** — deterministic re-execution, step bisection, auto-distill failures to evals-v1 (substrate: envelope-v1/ADR-023, Modal snapshots, PR #569 evals).
- **Idea 2** — nightly optimizer, immutable eval gate, flag-gated autonomous ship.
- **Idea 1** — verified-discovery write-back as bi-temporal edges (PR #563), git-diff expiry, temporal restriction on recall.
- **Idea 8** — trace-first debugging, narrow two-phase scope.
- **Idea 9 (start)** — macro mining: cluster traces by semantic task signature, human-reviewed candidates.
- **Milestone:** the optimizer ships its first validated harness patch; every thumbs-down becomes an eval within 24 hours.

### Phase 3 · The economic moat · H1 2027
- **Idea 9** — typed-hole deterministic macro replay behind executed-test gates.
- **Idea 10** — Pareto routing on verified outcomes; first refund-backed accuracy SLA on test-verifiable classes.
- **Idea 3** — read-only speculative execution, sandbox pre-warm, prefetch.
- **Milestone:** first customer contract with a priced, refund-backed accuracy SLA.

**Dependencies:** 5+6 form the verifier that 10 sells · 7 feeds 2 · 1 grounds localization for everything · 9 compiles what the fleet proves.

## Risks, stated plainly

- **Optimizer reward hacking** (DGM disabled its own failure logging) → eval harness immutable to the optimizer; human-readable diffs even on autonomous ships.
- **Verifier coverage** (RLVR's open "verifier problem" beyond math/code) → SLA scoped to test-verifiable classes, expands with the verifier.
- **Copilot fast-follow on memory** (ships today) → ship P2 on schedule; win on as-of-commit queries, provenance, and fleet lineage a TTL cache cannot express.
- **Evidence gaps we close ourselves:** edit-interface data is one unreplicated blog study; the mutation gate has no published bench impact → P1 ablations, which double as publishable research.
- **Speculation side effects** (Ghost Tool Calls) → read-only, sandbox-local speculation, enforced by contract.
- **Memory-as-contamination optics** → temporal restriction, no-retrieval guard during evaluation, replayable submissions as standing proof.

## Key sources

- arXiv:2602.18998 (CMU verification gap) · arXiv:2604.25850 (Agentic Harness Engineering) · arXiv:2606.09498 (Self-Harness) · arXiv:2505.22954 (Darwin Godel Machine)
- cursor.com/blog/reward-hacking-coding-benchmarks · openai.com/index/why-we-no-longer-evaluate-swe-bench-verified · alphasignal.ai (SWE-bench Pro audit)
- kenmuse.com (Copilot Agentic Memory) · arXiv:2501.13956 (Graphiti) · github.com/colbymchenry/codegraph
- arXiv:2603.18897 (PASTE) · arXiv:2606.02483 (Ghost Tool Calls)
- github.com/adenhq/hive #4752 (hashline) · github.com/openai/codex #12987 · github.com/anthropics/claude-code #25775 · blog.can.ac/2026/02/12/the-harness-problem
- forum.cursor.com (Cursor 2.2 multi-agent judging) · github.com/swe-bench/experiments checklist.md (Best@k) · arXiv:2604.16529 (RTV/PDR test-time scaling) · arXiv:2605.08680 (Semantic Voting)
- engineering.fb.com (Meta ACH) · mutahunter.ai · arXiv:2602.08146 (AdverTest)
- rr-project.org · antithesis.com · docs.temporal.io · docs.langchain.com (time travel) · zenml.io/product/kitaru · braintrust.dev
- blog.jetbrains.com (Junie GA) · withpointbreak.com · arXiv:2503.21557 (debug-gym) · arXiv:2606.24820 (SHERLOC) · arXiv:2606.26978 (To Run or Not to Run)
- arXiv:2606.26669 (Skill-DisCo) · arXiv:2605.25430 (CODESKILL) · arXiv:2606.20363 (negative GUI-mining result)
- arXiv:2406.18665 (RouteLLM) · arXiv:2601.19402 (PROTEUS) · sierra.ai · gleap.io (Fin pricing) · langchain.com (LangSmith Engine) · tbench.ai/leaderboard · swe-rebench.com
