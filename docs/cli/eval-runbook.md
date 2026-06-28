# Oxagen CLI — Scientific Evaluation Runbook

**Status:** living doc · **Last reviewed:** 2026-06-28 · **Scope:** `apps/cli` (`@oxagen/cli`, the `oxagen` binary), `packages/agent-engine`, `packages/engram`, `bench/terminal-bench`.

This runbook is the protocol for **scientifically proving** that the Oxagen CLI coding agent is superior to other agentic coding CLIs (Claude Code, Aider, OpenHands, Codex CLI, Cursor CLI, …), and specifically for proving the central thesis:

> **Thesis (H₀ to be rejected):** Pairing the agent loop with a **knowledge graph of code**, a **graph of executions**, and a **graph of memories** produces a *self-improving* coding agent — one whose task performance measurably increases as the graphs accumulate state, and reverts when the graphs are wiped.

A claim is only "proven" in the scientific sense if the experiment that produced it was **designed to be able to disprove it.** This document is therefore built around **falsification, controlled ablation, pre-registration, and statistics** — not a demo reel. If you run this protocol honestly and the numbers don't move, the thesis is wrong and you will know it. That is the point.

Every Oxagen mechanism referenced below is anchored to a source file. External-tool behavior is described from public feature sets as of mid-2026.

---

## Table of contents

1. [What "scientifically prove" requires](#1-what-scientifically-prove-requires)
2. [The system under test (mechanism map)](#2-the-system-under-test-mechanism-map)
3. [Hypotheses — decomposed and falsifiable](#3-hypotheses--decomposed-and-falsifiable)
4. [Independent & dependent variables](#4-independent--dependent-variables)
5. [The core experimental design: a 2³ ablation factorial](#5-the-core-experimental-design-a-2³-ablation-factorial)
6. [Controlling confounds (the part everyone skips)](#6-controlling-confounds-the-part-everyone-skips)
7. [The self-improvement experiment (the hard one)](#7-the-self-improvement-experiment-the-hard-one)
8. [Statistical analysis plan](#8-statistical-analysis-plan)
9. [Step-by-step runbook](#9-step-by-step-runbook)
10. [Threats to validity & how to neutralize them](#10-threats-to-validity--how-to-neutralize-them)
11. [Publicly available benchmarks](#11-publicly-available-benchmarks)
12. [Publicly available eval frameworks / harnesses](#12-publicly-available-eval-frameworks--harnesses)
13. [Pre-registration & reporting template](#13-pre-registration--reporting-template)

---

## 1. What "scientifically prove" requires

You cannot prove superiority with a leaderboard screenshot. To make a defensible scientific claim you need all six of the following. Each maps to a later section.

| Requirement | Why | Where |
|---|---|---|
| **Falsifiable hypotheses** | "Better" is not testable; "resolves ≥X% more SWE-bench Verified instances at p<0.05" is. | [§3](#3-hypotheses--decomposed-and-falsifiable) |
| **A controlled baseline** | Superiority is relative. You need both an *external* baseline (Claude Code) and an *internal* baseline (Oxagen with graphs OFF). | [§4](#4-independent--dependent-variables), [§5](#5-the-core-experimental-design-a-2³-ablation-factorial) |
| **Ablation** | To attribute improvement *to the graphs specifically* (not the model, the prompt, the harness), you must turn each graph layer off and measure the delta. This is the only way to establish causation. | [§5](#5-the-core-experimental-design-a-2³-ablation-factorial) |
| **Confound control** | Same model, gateway, temperature, dataset, container, and harness on every arm — or the result is meaningless. | [§6](#6-controlling-confounds-the-part-everyone-skips) |
| **Statistical rigor** | Agent runs are noisy. You need adequate n, multiple seeds, paired significance tests, confidence intervals, and effect sizes — not a single run. | [§8](#8-statistical-analysis-plan) |
| **Pre-registration & reproducibility** | Decide success criteria, metrics, and sample size *before* looking at results, or you are p-hacking. Publish seeds, configs, and raw logs. | [§13](#13-pre-registration--reporting-template) |

**The self-improvement claim is special.** Every public coding benchmark (SWE-bench, Terminal-Bench, Aider, …) is *single-shot and stateless* — it runs each task once on a fresh agent and measures pass/fail. None of them measure learning over time. Proving "self-improvement" therefore requires a **longitudinal design layered on top of those benchmarks** (see [§7](#7-the-self-improvement-experiment-the-hard-one)), not the benchmarks alone.

---

## 2. The system under test (mechanism map)

The thesis names three graphs and a feedback loop. Here is exactly how each is implemented, so the experiments target real toggles rather than a story. (Anchors verified 2026-06-28.)

### 2.1 Graphed code
- **Local:** `apps/cli/src/agent/code-graph.ts` builds/caches a TypeScript AST index; `apps/cli/src/daemon/code-graph/{builder,query}.ts` index files→symbols and answer `search` / `file_symbols` / `dependents` / `imports`.
- **Injected as a tool:** `packages/agent-engine/src/tools.ts` exposes the optional `code_graph` tool into the loop via the `CodeGraphProvider` port (`packages/agent-engine/src/types.ts:31`).
- **Platform:** Neo4j-backed `ontology.neighbors` / `ontology.query` contracts (`packages/oxagen/src/contracts/ontology.*.ts`).
- **The toggle:** present/absent `CodeGraphProvider` ⇒ `code_graph` tool available or not.

### 2.2 Graphed executions
- **Local:** `apps/cli/src/agent/trace-store.ts` persists per-turn traces (model, prompt, diff, tokens, cost, advisor) to `~/.config/oxagen/traces/<project>.json`; schema in `apps/cli/src/agent/trace-format.ts`.
- **Platform:** `agent.execution.record` (`packages/oxagen/src/contracts/agent.execution.record.ts`) records steps, tool calls, latency, failure reasons, cost as lineage queryable via `ontology.query`.
- **The toggle:** `TraceStore` port wired or a no-op.

### 2.3 Graphed memories
- **Local episodic substrate:** `packages/engram/` (`createEngram()` — remember/assert/relate/pin); opened per-session in `apps/cli/src/agent/memory.ts`.
- **Fleet memory + recall:** `apps/cli/src/agent/fleet/memory.ts` (`openFleetMemory()`), lexical recall (term overlap + 3× file-overlap boost + weight); lessons written by `recordSuccess()/recordFailure()` in `apps/cli/src/agent/fleet/orchestrator.ts`.
- **Platform:** `agent.memory.write` / `agent.memory.recall` (`packages/oxagen/src/contracts/agent.memory.*.ts`), Neo4j `:AgentMemory`.
- **The toggle:** `MemoryProvider` port wired or a no-op; recall returns ∅.

### 2.4 The self-improvement loop
`apps/cli/src/agent/prompt-enhancer.ts` (`enhancePrompt()`) injects code-graph context **and** recalled lessons before a task; `fleet/orchestrator.ts` calls it before each dispatch and records outcomes after. So task N's prompt is conditioned on what tasks 1…N-1 wrote into the graphs. **This loop is the thing under test.**

### 2.5 Shared engine & existing eval harness
- **Engine:** `packages/agent-engine/src/engine.ts` (`runCodingAgent()`, line 29) with injected ports — `ai` / `workspace` / `codeGraph` / `memory` / `traceStore` (`MemoryProvider`/`TraceStore` in `ports.ts:68,75`; `CodeGraphProvider` in `types.ts:31`), per ADR-019. The same loop runs locally and in the platform sandbox, so the ablation toggles are *literally just which ports you inject.*
- **Context-quality harness:** `packages/engram/src/eval/{harness,metrics,golden-traces,report}.ts` — `runEvalSuite()` replays golden traces and computes `EvalMetrics` (below); `detectRegressions()` gates against a baseline.
- **Agent-task harness:** `bench/terminal-bench/` — a Harbor adapter (`src/oxagen_terminal_bench`) that already produced a head-to-head (`results-oxagen/` vs `results-claude/`).

`EvalMetrics` (from `packages/engram/src/eval/metrics.ts`) — reuse these field names verbatim:

```ts
contextPrecision   // of what was packed, how much did the model use?  ↑ better
contextRecall      // of what the model needed, how much was present?  ↑ better
tokensToSuccess    // total tokens to complete the task                ↓ better
retrievalHitRate   // % of retrieval queries that returned useful hits ↑ better
cacheHitRate       // prompt cache hit rate                            ↑ better
turnLatency        // { p50, p95, p99 } ms
costPerTask        // USD                                              ↓ better
```

---

## 3. Hypotheses — decomposed and falsifiable

State each hypothesis with a direction, a metric, and a threshold **before** running anything. The primary metric is **task resolution rate** (`resolved@1` — instance passes the held-out verifier/test on a single attempt). Everything else is secondary/efficiency.

| ID | Hypothesis | Falsified if… |
|---|---|---|
| **H1 (code graph)** | Enabling the code graph raises `resolved@1` and lowers `tokensToSuccess` on multi-file tasks vs. the same agent with it off. | Δ`resolved@1` ≤ 0 or not significant at p<0.05. |
| **H2 (execution graph)** | Access to prior-execution lineage raises `resolved@1` on tasks similar to ones the agent has seen. | No significant lift on the "similar-task" stratum. |
| **H3 (memory graph)** | Recalled weighted lessons reduce repeated-mistake rate and raise `resolved@1` vs. memory off. | Repeat-failure rate and `resolved@1` statistically unchanged. |
| **H4 (self-improvement — the thesis)** | With all three graphs persisted across a task *sequence*, `resolved@1` **increases monotonically** with accumulated graph state, and **a graph wipe reverts the gain.** | Learning-curve slope ≤ 0, OR wipe does not significantly drop performance (⇒ gains were from contamination/model, not the graphs). |
| **H5 (external superiority)** | Full Oxagen (all graphs on, warm) beats Claude Code on `resolved@1` at equal model + equal task set + equal budget. | Δ ≤ 0 or inside the confidence interval. |

> **H4 is the crux.** H4 has two clauses joined by AND. The *monotonic-increase* clause alone is weak — a model could be memorizing the benchmark, or later tasks could be easier. The **wipe-reverts** clause is what makes H4 a causal claim: if you delete the graphs and performance falls back to the cold-start baseline, the only thing that changed was the accumulated graph state, so *it* caused the improvement. Design every self-improvement run to test both clauses.

---

## 4. Independent & dependent variables

**Independent (what you manipulate):**
- `G_code ∈ {on, off}` — `CodeGraphProvider` injected or not.
- `G_exec ∈ {on, off}` — `TraceStore` lineage wired or no-op.
- `G_mem ∈ {on, off}` — `MemoryProvider` + recall wired or no-op.
- `Agent ∈ {oxagen, claude-code, aider, openhands, …}` — external arm.
- `History depth h ∈ {0, 1, 2, …}` — how many prior tasks' state is present (self-improvement only).

**Dependent (what you measure):**
- **Primary:** `resolved@1` (binary per instance), `resolved@k` for k∈{1,5}.
- **Efficiency:** `tokensToSuccess`, `costPerTask`, turns-to-resolution, `turnLatency.{p50,p95,p99}`.
- **Quality:** regression rate (did the fix break another test?), repeat-failure rate (same root-cause failure recurring), diff size, lint/typecheck pass.
- **Graph-specific:** `contextPrecision`, `contextRecall`, `retrievalHitRate`, `cacheHitRate`.

**Controlled (held constant — see [§6](#6-controlling-confounds-the-part-everyone-skips)):** model id, gateway, temperature, max-turns/token budget, task set, container image, verifier, network egress policy.

---

## 5. The core experimental design: a 2³ ablation factorial

To attribute lift to the graphs (not the model or harness), run a **full factorial** over the three toggles. Eight cells:

| Cell | `G_code` | `G_exec` | `G_mem` | Name |
|---|---|---|---|---|
| C0 | off | off | off | **Internal baseline** (bare loop) |
| C1 | on | off | off | +code |
| C2 | off | on | off | +exec |
| C3 | off | off | on | +mem |
| C4 | on | on | off | +code+exec |
| C5 | on | off | on | +code+mem |
| C6 | off | on | on | +exec+mem |
| C7 | on | on | on | **Full Oxagen** |
| — | — | — | — | **Claude Code** (external arm, no Oxagen graphs) |

What the factorial buys you:
- **Main effect of each graph** = mean(cells with it ON) − mean(cells with it OFF). This is the honest "how much does the code graph add?" number, averaged over the presence/absence of the other two.
- **Interactions** = does code+mem together beat the sum of code-alone and mem-alone? (The thesis predicts a positive interaction — the graphs compound.) A 2³ factorial is the *only* design that exposes interactions; running each graph in isolation cannot.
- **C0 vs C7** = the total system lift. **C0 vs Claude Code** = "is our bare loop even competitive?" (sanity check; if our bare loop already beats Claude Code, attributing gains to the graphs gets harder — you must report this).

Run all 8 cells (+ external arms) on the **same instances, same seeds**. Use `bench/terminal-bench` and SWE-bench Verified ([§11](#11-publicly-available-benchmarks)) as the task substrates. Because the toggles are *just which ports you inject* (`packages/agent-engine/src/{ports,types}.ts`), all eight cells run the identical engine — that is the cleanest possible ablation.

---

## 6. Controlling confounds (the part everyone skips)

A superiority claim dies on confounds. Lock all of these or the result is unpublishable.

1. **Same underlying model on every arm.** Run Oxagen *and* Claude Code on the *same* model id (e.g. both on `claude-sonnet-4-6` via the gateway — `modelIdOf()`, per the AI-Gateway memory note). If you let Oxagen use Opus and Claude Code use Sonnet, you measured the model, not the harness. Report a second pairing too (both on a frontier model) to show the effect isn't model-specific.
2. **Pin everything.** Model id, gateway revision, temperature (set deterministic where supported; otherwise hold equal), `top_p`, max-turns, token/cost budget per task, system-prompt length budget. Record them in the pre-registration ([§13](#13-pre-registration--reporting-template)).
3. **Identical task substrate & verifier.** Same instances, same held-out tests, same container image, same timeout. Terminal-Bench/Harbor and SWE-bench harnesses give you this for free — use their official containers; never hand-grade.
4. **Network & tool parity.** Either both agents get web/tool access or neither does. An agent that can `curl` a fix has an unfair edge. Pin egress.
5. **Seeds & repeats.** Fix RNG seeds; run **≥5 repeats per instance per cell** to average over model nondeterminism (temperature, tie-breaking). Report mean ± 95% CI, not a single run.
6. **Order & contamination control.** Randomize task order per repeat. For self-improvement runs, the warm agent must **never** have its train tasks overlap its eval tasks (held-out transfer set — [§7](#7-the-self-improvement-experiment-the-hard-one)).
7. **Benchmark-contamination check.** Frontier models may have memorized SWE-bench. Mitigate by *also* running a contamination-resistant set (SWE-bench **Live**, LiveCodeBench, or your own private repo tasks) and showing the effect holds there.
8. **Blind the grader.** Verification is automated (tests pass/fail) — keep it that way. If any human judgment enters (e.g. diff quality), the rater must not know which arm produced the diff.
9. **Cost/latency normalization.** Report `resolved@1` *and* `cost-per-resolved-instance`. "Better" at 10× the cost is a different claim than "better at equal cost." State which you're making.

---

## 7. The self-improvement experiment (the hard one)

This is the experiment that proves H4 and is the heart of your thesis. Public benchmarks are stateless, so you build the longitudinal layer yourself on top of them.

### 7.1 Train / eval split with a held-out transfer set
- Partition a task corpus into **TRAIN** (the agent works these *with graphs persisting*, accumulating code/exec/memory state) and **EVAL** (a held-out set the agent is scored on but whose solutions never enter the graphs).
- **EVAL must be disjoint from TRAIN.** If the agent "improves" only on tasks it has literally already solved, that's caching, not generalization. The scientific claim is *transfer* — improvement on **unseen** tasks because of accumulated structure.
- Stratify EVAL into **near-transfer** (same repos/domains as TRAIN — exercises code & exec graphs) and **far-transfer** (different repos — exercises only generalizable memories/conventions). The thesis predicts near-transfer lifts most.

### 7.2 The learning curve (monotonic-increase clause)
1. Start cold: wipe all graphs (`~/.config/oxagen/traces/*`, fleet memory store, engram DB, and the platform Neo4j `:AgentMemory` / code-graph for the test org).
2. Score the agent on the full EVAL set → this is **h=0** (cold-start baseline).
3. Have the agent work a batch of TRAIN tasks (graphs persist).
4. Re-score on EVAL (a *fresh* run — no EVAL state was written) → **h=1**.
5. Repeat steps 3–4 across batches → produces `resolved@1` as a function of history depth `h`.
6. **Fit the curve.** H4's first clause holds iff the slope is significantly > 0 (mixed-effects model, [§8](#8-statistical-analysis-plan)). Plot it. A flat or noisy line falsifies the increase clause.

### 7.3 The wipe-reversion test (causal clause)
This is what separates *learning* from *confounds*. After the warm agent reaches its peak `h`:
1. Score warm (peak) on EVAL → `R_warm`.
2. **Wipe the graphs** (graphs only — same model, same code, same prompt).
3. Immediately re-score on EVAL → `R_wiped`.
4. H4's causal clause holds iff `R_warm − R_wiped` is significant and ≈ `R_warm − R_cold`. If wiping the graphs does **not** drop performance, the gains came from something else (model drift, benchmark memorization, easier EVAL ordering) and **the thesis is not supported** — report that honestly.
5. **Re-warm control:** let it re-accumulate and confirm performance climbs back. A reproducible drop-and-recover is strong causal evidence.

### 7.4 Ablated learning curves
Run §7.2 separately with each graph alone (C1/C2/C3) and full (C7). Compare slopes. The thesis predicts: **C7 slope > each single-graph slope > C0 slope ≈ 0.** Different slopes localize *which* graph drives learning, and whether they compound (positive interaction from §5).

### 7.5 Repeated-mistake metric (direct mechanism evidence)
Beyond pass/fail, instrument the specific mechanism: tag each failure with a root-cause signature. Measure the rate at which a *previously-seen* failure signature recurs. The memory graph's whole job (`recordFailure()` → `gotcha` lesson → recall) is to drive this down. A falling repeat-failure rate with `G_mem=on` and a flat one with `G_mem=off` is the cleanest possible evidence that the memory loop works — independent of the noisier `resolved@1` signal.

---

## 8. Statistical analysis plan

Decide all of this **before** collecting data.

- **Unit of analysis:** instance × repeat. With per-instance pairing across cells, use **paired** tests (each instance is its own control).
- **Binary outcomes (`resolved@1`):** **McNemar's test** for paired arms (A solves / B fails vs. B solves / A fails). Report the odds ratio and a 95% CI.
- **Continuous outcomes (tokens, cost, turns):** paired bootstrap (10k resamples) for the mean difference + 95% CI; or Wilcoxon signed-rank if you prefer rank-based. These are skewed — **do not** assume normality / use a bare t-test.
- **Learning curve (H4):** a **mixed-effects logistic regression** — `resolved ~ history_depth + (1 | instance) + (1 | repo)` — random intercepts for instance and repo absorb difficulty heterogeneity. The fixed-effect coefficient on `history_depth` is your learning slope; test it ≠ 0. This is far stronger than eyeballing a line through batch means.
- **Effect sizes, always.** Report Δ in percentage points and a standardized effect (Cohen's h for proportions; Cliff's δ for ranked efficiency metrics). A statistically-significant +0.4pp lift is not a product story; report magnitude, not just p.
- **Multiple comparisons.** You're testing many cells/metrics — control the false-discovery rate (Benjamini–Hochberg) across the hypothesis family. One uncorrected p<0.05 among 30 tests is noise.
- **Power & sample size.** Pick the minimum detectable effect (e.g. +5pp `resolved@1`) and the baseline rate, then compute n. Rule of thumb for paired proportions at 80% power / α=0.05 / +5pp around a 40% base rate: low-hundreds of *discordant* pairs → plan for **≥300 instance-runs per cell** (= e.g. 60 instances × 5 repeats). SWE-bench Verified's 500 instances is sized for exactly this; Terminal-Bench's ~100 tasks need more repeats to compensate. Under-powering is the #1 way these studies produce non-replicable "wins."
- **Pre-register the stopping rule.** No peeking-then-adding-runs-until-significant. Fix n up front or use a sequential design with alpha-spending.

---

## 9. Step-by-step runbook

> **Test-execution discipline (from CLAUDE.md):** never run the whole repo suite. Eval runs are *benchmark* runs, isolated to `bench/` and `packages/engram`, and must be invoked explicitly with pinned configs — not via `pnpm test` / `turbo run test`. Heavy runs go on a dedicated machine, not your laptop dev loop.

### Phase A — Build the substrate (once)
1. **Freeze a config.** Write `bench/configs/<run-id>.json`: model id, gateway rev, temperature, budgets, seed list, task set, container tag. This file is the experiment's identity — commit it.
2. **Curate task sets.** Pull SWE-bench Verified + SWE-bench Live + your private repo set ([§11](#11-publicly-available-benchmarks)). Keep TRAIN/EVAL splits in version control. Verify EVAL∩TRAIN=∅ with a checksum diff.
3. **Wire the ablation switch.** The 8 cells are port-injection profiles in `packages/agent-engine`. Add a `--graphs=code,exec,mem` (subset) flag to the bench adapter that selects which ports get real impls vs. no-ops. *Do not* fork the loop — same `runCodingAgent()`, different ports, or the ablation is invalid.

### Phase B — Cross-sectional ablation (H1–H3, H5)
4. **Run the factorial.** For each cell C0–C7 + Claude Code, run every EVAL instance × ≥5 seeds inside the official benchmark container.
   - Agent-task substrate: `bench/terminal-bench` Harbor adapter (already produces `result.json` with `pass_at_k` / `reward_stats` — extend the head-to-head you already have in `results-oxagen/` vs `results-claude/`).
   - Context-quality substrate: `runEvalSuite()` from `packages/engram/src/eval/harness.ts` over golden traces → emits `EvalMetrics` per turn; `detectRegressions()` flags drops vs. the C0 baseline.
5. **Collect raw logs.** Persist every trajectory (trace-store JSON + Harbor trial logs). Raw artifacts are required for the reproducibility claim — never discard them.

### Phase C — Longitudinal self-improvement (H4)
6. **Cold baseline.** Wipe graphs, score EVAL → `h=0`.
7. **Train/score loop.** Work TRAIN batches with graphs persisting; re-score EVAL after each batch (§7.2). Capture `resolved@1(h)`.
8. **Wipe-reversion.** At peak `h`, score → wipe graphs → re-score → re-warm (§7.3). This is the single most important measurement in the whole runbook.
9. **Per-graph curves.** Repeat 6–8 for C1/C2/C3/C7 to localize the effect (§7.4).

### Phase D — Analysis & report
10. **Run the stats** ([§8](#8-statistical-analysis-plan)): McNemar per arm pair, bootstrap CIs for efficiency, mixed-effects slope for the learning curve, BH correction across the family.
11. **Fill the report template** ([§13](#13-pre-registration--reporting-template)). State which hypotheses were supported, the effect sizes, the cost-normalized comparison, and — critically — **any hypothesis that was falsified.**
12. **Publish for reproduction:** config files, seeds, splits, raw trajectories, analysis notebook. Superiority that can't be reproduced isn't proven.

---

## 10. Threats to validity & how to neutralize them

| Threat | Risk | Neutralizer |
|---|---|---|
| **Benchmark contamination** | Model memorized SWE-bench solutions → inflated, and a false "learning" signal. | Add SWE-bench **Live** / LiveCodeBench / private repos ([§6.7](#6-controlling-confounds-the-part-everyone-skips)); show effect holds there. |
| **Confounded model** | Oxagen on a stronger model than the baseline. | Same model id on every arm ([§6.1](#6-controlling-confounds-the-part-everyone-skips)). |
| **Train/eval leakage** | "Improvement" is just re-solving seen tasks. | Disjoint EVAL with a checksum-verified split; report far-transfer separately ([§7.1](#71-train--eval-split-with-a-held-out-transfer-set)). |
| **Learning is an illusion** | Curve rises from easier task ordering or model drift, not the graphs. | The wipe-reversion test ([§7.3](#73-the-wipe-reversion-test-causal-clause)) — the decisive causal control. |
| **Nondeterminism mistaken for signal** | Single runs; temperature noise. | ≥5 seeds/instance, CIs, adequate power ([§8](#8-statistical-analysis-plan)). |
| **Harness asymmetry** | Oxagen gets more turns / tools / budget than the baseline. | Equal budgets, equal tool access, equal containers ([§6](#6-controlling-confounds-the-part-everyone-skips)). |
| **Cherry-picked metric** | Reporting only the metric that won. | Pre-register the primary metric; report all; BH-correct ([§8](#8-statistical-analysis-plan), [§13](#13-pre-registration--reporting-template)). |
| **Overfitting to one benchmark** | Wins on SWE-bench, loses elsewhere. | Report ≥3 independent benchmarks ([§11](#11-publicly-available-benchmarks)); a real edge generalizes. |
| **Cost hidden** | Winning at 10× spend. | Always report cost-per-resolved-instance ([§6.9](#6-controlling-confounds-the-part-everyone-skips)). |

---

## 11. Publicly available benchmarks

Use a **portfolio** — no single benchmark proves general superiority, and using ≥3 independent ones is itself a validity control ([§10](#10-threats-to-validity--how-to-neutralize-them)). Grouped by what they measure. ("Public" = openly available dataset + harness you can run yourself.)

### Tier 1 — Agentic, repo-level (the ones that matter for a coding CLI)
| Benchmark | What it measures | Why use it | Notes |
|---|---|---|---|
| **SWE-bench** (Princeton) | Resolve real GitHub issues across a repo; patch must pass held-out tests. | The field standard for agentic coding; `resolved@1` is the headline number. | Large; some contamination risk. |
| **SWE-bench Verified** | 500 human-validated SWE-bench instances. | Cleaner labels; sized right for the power analysis in [§8](#8-statistical-analysis-plan). | **Start here.** |
| **SWE-bench Lite** | 300 lightweight instances. | Cheap smoke-test / dev loop. | Less representative. |
| **SWE-bench Multimodal** | Issues with images/visual context (JS front-ends). | Tests multimodal + UI repair. | Narrower. |
| **SWE-bench Live** | Continuously-refreshed instances from recent issues. | **Contamination-resistant** — critical control for the learning claim. | Use as your anti-contamination set. |
| **Multi-SWE-bench** | SWE-bench across many languages (Java, Go, Rust, TS, …). | Proves you're not Python-only. | |
| **Terminal-Bench** (Harbor / Stanford+Laude) | End-to-end terminal tasks in containers (build, debug, configure, ops). | **You already have the adapter** (`bench/terminal-bench`) and a Claude Code head-to-head ([first-run results](./terminal-bench-results.md)). CLI-shaped — perfect fit. | Extend the existing run. |
| **SWE-Lancer** (OpenAI) | Real Upwork freelance SWE tasks with $ payouts; full-stack. | Economically-grounded "is the work shippable" signal. | Larger tasks. |
| **SWT-bench** | Generate tests that reproduce a bug (the inverse of SWE-bench). | Tests reasoning about *failure*, which your exec/memory graphs target. | |

### Tier 2 — Code editing & repo context (good for the code-graph ablation)
| Benchmark | What it measures | Notes |
|---|---|---|
| **Aider polyglot benchmark** | Edit-and-pass across many languages; strict diff/edit-format discipline. | Cheap, fast, popular; great for the C0-vs-C1 (code-graph) contrast. |
| **RepoBench** | Repository-level code completion (cross-file retrieval). | Directly stresses the code graph. |
| **CrossCodeEval** | Cross-file completion requiring repo context. | Same — isolates retrieval value. |
| **LiveCodeBench** | Contamination-free competitive-programming, continuously updated. | Anti-contamination control alongside SWE-bench Live. |
| **BigCodeBench** | Practical tasks with complex/compositional library calls. | Realistic API usage. |
| **CoderEval** | Pragmatic, non-standalone functions from real projects. | |

### Tier 3 — Function-level (baselines / sanity only — weak for agents)
| Benchmark | What it measures | Notes |
|---|---|---|
| **HumanEval / HumanEval+** | Single-function synthesis. | Saturated; use only as a floor. |
| **MBPP / MBPP+** (EvalPlus) | Basic Python problems with strengthened tests. | Same caveat. |
| **ClassEval** | Class-level generation. | Slightly more realistic than function-level. |

### Tier 4 — Broader agentic / specialist (optional, for breadth claims)
| Benchmark | What it measures | Notes |
|---|---|---|
| **MLE-bench** (OpenAI) | Kaggle-style ML engineering end-to-end. | If you claim ML-eng competence. |
| **RE-Bench** (METR) | AI R&D / research-engineering tasks vs. human baselines. | Hard; frontier-agent territory. |
| **GAIA** | General assistant reasoning + tool use. | Generalist, not coding-specific. |
| **τ-bench / τ²-bench** | Tool-agent-user interaction over multiple turns. | Tests the multi-turn loop. |
| **Cybench** | Cybersecurity CTF tasks. | Only if relevant to your positioning. |
| **DevBench / DevQualityEval** | Full dev lifecycle / code-quality across languages. | Breadth. |
| **CORE-bench** | Reproducing computational results from papers. | Niche. |

Tiers 1–4 above all measure **output quality** (did the task succeed). The thesis is equally about **context/memory quality and self-improvement** — Tiers 5–7 are the benchmarks for that axis. They matter because a coding agent's edge from a knowledge graph shows up as *better-packed context* and *improvement with experience*, which a pass/fail coding benchmark cannot isolate.

### Tier 5 — Context & retrieval (RAG) quality — *computes your `EvalMetrics` directly*
Oxagen's `contextPrecision` / `contextRecall` (`packages/engram/src/eval/metrics.ts`) **are** the RAG-evaluation triad. These score them on real data:
| Benchmark / tool | What it measures | Notes |
|---|---|---|
| **RAGAS** | context precision, context recall, faithfulness, answer relevancy. | 1:1 with engram's metrics. **Wired in `bench/rag-eval/`** as the external cross-validation. |
| **TruLens** | the "RAG triad": context relevance / groundedness / answer relevance. | Alternative scorer; pairs with the trace store. |
| **CRAG** (Meta), **FRAMES** (Google), **MTRAG** (IBM), **MultiHop-RAG**, **RAGBench** | Public RAG datasets (single- & multi-hop retrieval+reasoning). | Use when you want a public corpus beyond your golden traces. |
| **BEIR** + **MTEB** | Retriever-only quality (nDCG / MRR / Recall@k). | Only if you tune the embedding/retriever. |

### Tier 6 — Long-context utilization — *does the model use what you packed under budget?*
| Benchmark | What it measures | Notes |
|---|---|---|
| **RULER** | Needle / multi-hop / aggregation at configurable context lengths. | Current standard for context utilization. |
| **HELMET** (Princeton) | Application-level long-context suite. | More realistic than raw needle. |
| **NoLiMa** | Needle retrieval with **no literal lexical match** (semantic). | Hard; tests true semantic retrieval. |
| **NIAH**, **InfiniteBench**, **LongBench v2**, **BABILong**, **LOFT** | Needle-in-haystack / long-context reasoning with distractors. | Breadth of length stress. |

### Tier 7 — Agent memory & self-improvement — *the closest public proxy for the thesis*
| Benchmark | What it measures | Notes |
|---|---|---|
| **LongMemEval** | Long-term memory across sessions (extraction, multi-session reasoning, knowledge updates, temporal reasoning, abstention). | **Top pick for memory quality.** |
| **LoCoMo** | Very-long multi-session dialogue QA requiring far-back recall. | Memory-recall prerequisite. |
| **MemoryAgentBench** / agent-memory benchmarks | Accurate retrieval, test-time learning, conflict resolution. | Recent (2024–25); verify current release. |
| **StreamBench** | **Continuous improvement of an agent from a feedback stream.** | The most on-point public benchmark for "gets better with experience." |
| **LifelongAgentBench** | Lifelong / continual learning across a task stream. | Continual-learning framing. |

> **Mapping to the thesis (both axes):**
> - **Output quality (A):** the **code graph** shows up on RepoBench / CrossCodeEval / Aider-polyglot (cross-file retrieval); the **execution + memory graphs** show up on the *longitudinal* layer over SWE-bench Verified + Terminal-Bench (§7).
> - **Context/memory quality (B):** measure context packing with **RAGAS/TruLens** (Tier 5, wired in `bench/rag-eval/` and `packages/engram/src/eval/`), long-context use with **RULER** (Tier 6), and memory recall with **LongMemEval/LoCoMo** (Tier 7).
> - **Self-improvement:** almost everything public is single-shot; only **StreamBench** + **LifelongAgentBench** score it directly. For everything else, layer the longitudinal protocol (§7): a learning curve + the **wipe-reversion** causal test. LongMemEval/LoCoMo prove recall *works*; the wipe-reversion proves recall *improves task outcomes*.
> - **Anti-contamination controls:** SWE-bench Live + LiveCodeBench.
>
> **Minimum portfolio:** SWE-bench Verified + Terminal-Bench + SWE-bench Live (output) **and** RAGAS via `bench/rag-eval/` + LongMemEval + the §7 wipe-reversion on your warm `bench/context-eval` (context/self-improvement).

---

## 12. Publicly available eval frameworks / harnesses

Benchmarks are *datasets*; you still need a *runner*. Don't hand-roll what these give you (containerization, scoring, parallelism, reporting).

| Framework | What it is | Use it for |
|---|---|---|
| **Harbor / Terminal-Bench harness** | Container-based agent-task runner (the Terminal-Bench engine). | **Already integrated** at `bench/terminal-bench`. Your primary agent-task runner — extend it for the factorial. |
| **SWE-bench harness** (official) | Builds the per-instance Docker images and runs the held-out test suite to score patches. | Authoritative SWE-bench scoring — never grade patches yourself. |
| **SWE-agent / Moatless / OpenHands eval** | Reference agent scaffolds + SWE-bench eval loops. | Comparison baselines and a sanity check that your runner scores like theirs. |
| **Inspect AI** (UK AISI) | Production-grade eval framework: solvers, scorers, datasets, logging, sandboxing. | The cleanest way to wrap *all* arms (Oxagen, Claude Code, Aider) behind one scoring interface with proper logs. **Recommended backbone.** |
| **OpenAI Evals** | Open eval registry + runner. | Quick custom task definitions; community evals. |
| **EleutherAI lm-evaluation-harness** | The standard LLM benchmark runner (HumanEval, MBPP, …). | Tier-3 baselines. |
| **BigCode evaluation-harness** | Runner for BigCodeBench / HumanEval+ / multi-lingual code evals. | Tier-2/3 code benchmarks. |
| **EvalPlus** | Strengthened HumanEval+/MBPP+ test generation + runner. | Hardened function-level baselines. |
| **Promptfoo** | Declarative, CI-friendly eval/test runner with matrix configs + assertions. | Wiring the 2³ factorial as a config matrix; regression gating in CI. |
| **RAGAS** | Context precision / recall / faithfulness / answer relevancy (LLM-as-judge). | **Wired in `bench/rag-eval/`** with the AI Gateway as judge — the external cross-check of engram's `contextPrecision`/`contextRecall`. |
| **DeepEval** | Pytest-style LLM eval assertions + RAG metrics (`ContextualPrecision/Recall`, `Faithfulness`, `AnswerRelevancy`) + G-Eval. | Also wired in `bench/rag-eval/`; second opinion alongside RAGAS. |
| **TruLens** | RAG triad (context relevance / groundedness / answer relevance) + tracing. | Alternative RAG scorer if you want a third opinion. |
| **Arize Phoenix** | Retrieval eval + LLM tracing. | Pairs with the trace store for retrieval debugging. |
| **HELM** (Stanford CRFM) | Holistic, multi-metric benchmarking framework. | Multi-axis reporting if you want a HELM-style scorecard. |
| **LangSmith / Braintrust / Langfuse** | Hosted eval + trace observability platforms. | Trajectory storage, dataset versioning, human-in-the-loop grading, dashboards. |
| **RewardBench / JudgeBench / Prometheus 2** | Validate the LLM judge itself. | Run before trusting any LLM-as-judge metric above. |

### In-repo harnesses (live now)
These exist and run today — use them as the home base; reach for the public benchmarks above to scale coverage.
| Harness | Axis | Command | What it is |
|---|---|---|---|
| **`packages/engram/src/eval/`** | B (context) | `pnpm --filter @oxagen/engram eval:golden` (gate: `… test:unit`) | `runEvalSuite()` over an **instantiated golden trace** (`golden-fixtures.ts`) + deterministic compiler (`golden-compile.ts`); CI gate in `golden-suite.test.ts`. Emits `contextPrecision`/`recall`/`hit-rate`; `detectRegressions` fails on degradation. `eval:export` writes the RAGAS dataset. |
| **`bench/rag-eval/`** | B (context) | `python bench/rag-eval/run_rag_eval.py` | **RAGAS + DeepEval** over the AI Gateway judge; scores the same fixture the engram harness exports (`dataset.engram.jsonl`) — cross-validates the homegrown metrics against the standard ones. |
| **`bench/context-eval/`** | A + B | `python bench/context-eval/run_eval.py` (warm: `EVAL_ROUNDS=3 OXAGEN_ARMS=oxagen-warm …`) | Repo-Q&A accuracy + cost/tokens; **warm arm + `--rounds` learning curve + `--wipe-reversion`** implement the §7 self-improvement protocol. |
| **`bench/terminal-bench/`** | A | `./run.sh` (warm: `OXAGEN_WARM=1 …`) | Harbor `resolved@1`; **warm mode** persists memory across the task sequence for the §7 longitudinal layer. |

**Recommended stack:** Inspect AI (or Harbor) as the arm-agnostic runner → official SWE-bench / Terminal-Bench harnesses for output scoring → **`packages/engram` eval + `bench/rag-eval` (RAGAS/DeepEval)** for context-quality → **warm `bench/context-eval` + `bench/terminal-bench`** for the self-improvement learning curve and wipe-reversion → analysis notebook (mixed-effects + bootstrap) for [§8](#8-statistical-analysis-plan) → LangSmith/Langfuse for trajectory storage.

---

## 13. Pre-registration & reporting template

Fill **§13.1 before** running anything. Filling it after is p-hacking.

### 13.1 Pre-registration (commit this file before data collection)
```
Run ID:                <date>-<slug>
Primary hypothesis:    (e.g. H4 — self-improvement)
Primary metric:        resolved@1 on EVAL far-transfer
Direction & MDE:       +5pp, one-sided, α=0.05, power=0.80
Sample size:           <n instances> × <seeds> per cell  (justified by power calc)
Cells / arms:          C0..C7 + claude-code
Model (all arms):      <model id> @ <gateway rev>, temp=<t>, budget=<turns/tokens/$>
Task sets:             SWE-bench Verified vN + Terminal-Bench vN + SWE-bench Live <date> + <private>
TRAIN/EVAL split:      <checksum>, disjoint verified ✓
Stats:                 McNemar (binary), paired bootstrap (continuous), mixed-effects slope (H4), BH-corrected
Stopping rule:         fixed n (no peeking)
Falsification:         H4 rejected if learning slope ≤0 OR wipe-reversion Δ not significant
```

### 13.2 Results report
```
Per-cell resolved@1 (mean ± 95% CI), per benchmark
Main effects:   ΔG_code, ΔG_exec, ΔG_mem  (effect size + p, BH-corrected)
Interactions:   code×mem, etc.  (does the stack compound?)
Learning curve: slope coefficient ± CI; plot resolved@1(h)
Wipe-reversion: R_warm, R_wiped, R_cold; Δ + significance   ← the causal result
Repeat-failure rate: mem-on vs mem-off
External:       Oxagen-C7 vs Claude Code, equal model, at-equal-cost and at-best-effort
Efficiency:     tokensToSuccess, costPerResolved, turns, latency p50/p95/p99
Contamination control: same effects on SWE-bench Live / private set? (Y/N)
Hypotheses:     H1..H5 — supported / not supported (state each plainly)
Artifacts:      configs, seeds, splits, raw trajectories, analysis notebook (links)
```

### 13.3 The honesty clause
A scientific runbook must be willing to report a null or negative result. If the wipe-reversion test ([§7.3](#73-the-wipe-reversion-test-causal-clause)) shows no drop, or Oxagen-C7 doesn't beat Claude Code at equal model and cost, **say so and publish it.** A falsified hypothesis with clean methodology is a real finding and tells you where to improve the graphs — a "win" from a confounded or under-powered run is worth nothing and will not survive a competitor's replication. The credibility of every *supported* claim in your report rests on your willingness to report the unsupported ones.

---

## Appendix — quickest path to a first defensible number

If you need one credible result fast, do this minimal slice (it still satisfies the core of the science):

1. **One benchmark:** SWE-bench Verified (500 instances).
2. **Three cells:** C0 (bare), C7 (full graphs, warm), Claude Code — all on the **same model**.
3. **5 seeds** per instance.
4. **One longitudinal curve + wipe-reversion** on a 50-instance held-out EVAL slice (§7.2–7.3).
5. **Stats:** McNemar (C0 vs C7, C7 vs Claude Code) + the mixed-effects learning slope + the wipe Δ.
6. **Report** §13.2, including cost-per-resolved-instance.

That yields: "does the full graph stack beat the bare loop and Claude Code on the same model (cross-sectional), *and* does performance demonstrably accumulate-then-revert-on-wipe (longitudinal causal)?" — which is exactly the thesis, falsifiably tested. Scale up benchmarks, cells, and n from there.
