# Oxagen CLI — Terminal-Bench Eval Run (2026-06-27)

**Status:** results log · **Run date:** 2026-06-27 · **Author of record:** Mac Anderson · **Companion to:** [`eval-runbook.md`](./eval-runbook.md)

This document records the first head-to-head **Terminal-Bench** run of the Oxagen CLI agent against Anthropic's **Claude Code**, exactly as it happened — including the parts that didn't work. It is a *factual run log*, not a marketing result. Raw artifacts live in `bench/terminal-bench/results-oxagen/` and `bench/terminal-bench/results-claude/`; every number below is transcribed from the `result.json` files there.

> **Headline (read this first):** On the 2-task common slice, **Oxagen scored 0/2 and Claude Code scored 0/2** — a tie at zero on two of Terminal-Bench 2.0's hardest tasks. This run is a **harness-validation smoke test** (n=2 tasks, 1 attempt each), not a powered comparison. It proves the benchmark adapter works end-to-end and establishes a reproducible baseline; it does **not** support any superiority claim in either direction. See [§5 Caveats](#5-caveats--why-this-proves-nothing-yet) and the [eval-runbook](./eval-runbook.md) for what a real comparison requires.

---

## 1. What was run

| Field | Value |
|---|---|
| **Benchmark** | Terminal-Bench **2.0** (`laude-institute/terminal-bench-2`, commit `69671fbaac6d67a7ef0dfec016cc38a64ef7a77c`) |
| **Harness** | Harbor **0.16.0** (`harbor` Python pkg, `requires-python >=3.13`) |
| **Adapter** | `oxagen-terminal-bench` → `oxagen_terminal_bench:OxagenAgent` (`bench/terminal-bench/src/oxagen_terminal_bench/oxagen_agent.py`) |
| **Agent under test** | `oxagen` CLI **v0.6.1**, run as a self-contained bundle (`apps/cli/dist-standalone/oxagen.mjs`) installed into the task container; invoked headlessly as `oxagen --mode bypass --verbose --model <slug>` in the task working dir |
| **Baseline agent** | `claude-code` (Harbor's installed Claude Code adapter) |
| **Model (both)** | Claude Sonnet 4.5 — Oxagen: `anthropic/claude-sonnet-4.5`; Claude Code: `anthropic/claude-sonnet-4-5` (same model, slug spelled differently by each adapter) |
| **Environment** | Docker, ephemeral (`delete: true`), auto CPU/mem, `n_attempts: 1`, `max_retries: 0` |
| **Tasks** | `gpt2-codegolf`, `llm-inference-batching-scheduler` (Oxagen run #1 also included `break-filter-js-from-html`) |

### The two tasks (both very hard)
- **`gpt2-codegolf`** — write a **dependency-free C** program **under 5000 bytes** that loads GPT-2-124M weights from a TF `.ckpt` + a `.bpe` file and emits the next 20 arg-max tokens. Compiled with `gcc -O3 -lm`.
- **`llm-inference-batching-scheduler`** — a shape-aware batch-packing **optimization** task; the plan must beat hard cost / pad-ratio / P95-latency / timecost thresholds across two request buckets.

These are among the hardest tasks in TB2 — open-ended systems/optimization problems where even frontier agents have low solve rates. They were chosen as a stress test, not a representative sample.

---

## 2. Results

### 2.1 The head-to-head (common 2-task slice)

| Agent | Model | API route | Tasks | Completed | Errored | **Resolved** | **Score** | Tokens (in / cache / out) | Cost | Wall-clock |
|---|---|---|---|---|---|---|---|---|---|---|
| **Oxagen 0.6.1** | Sonnet 4.5 | Vercel AI Gateway (`ai-gateway.vercel.sh`) | 2 | 2 | 0 | 0 | **0 / 2 (0%)** | not captured¹ | not captured¹ | 17m 09s |
| **Claude Code** | Sonnet 4.5 | Anthropic direct (`api.anthropic.com`) | 2 | 2 | 0 | 0 | **0 / 2 (0%)** | 1,744,465 / 1,628,754 / 49,347 | **$1.66** | 11m 46s |

¹ The Oxagen Harbor adapter returned `null` for `n_input_tokens` / `n_cache_tokens` / `n_output_tokens` / `cost_usd`. This is an **instrumentation gap in the adapter**, not a missing cost — Oxagen meters internally via `invoke()`/ClickHouse. See [§6 Follow-ups](#6-follow-ups-this-run-surfaced).

### 2.2 Per-task rewards (reward ∈ {0.0, 1.0}; 1.0 = verifier passed)

| Task | Oxagen (run #2, 18:54) | Claude Code (18:58) |
|---|---|---|
| `gpt2-codegolf` | 0.0 (`gpt2-codegolf__saXZwmX`) | 0.0 (`gpt2-codegolf__8JeFgrc`) |
| `llm-inference-batching-scheduler` | 0.0 (`llm-inference-batching-scheduler__JYBcuWN`) | 0.0 (`llm-inference-batching-scheduler__H9vGGxM`) |

### 2.3 All three runs (full chronology)

| # | Run dir | Agent | Tasks | Completed | Errored | Reward | Runtime | Note |
|---|---|---|---|---|---|---|---|---|
| 1 | `results-oxagen/2026-06-27__18-35-47` | Oxagen 0.6.1 | 3 | 0 | **3** | 0.0 ×3 | 10m 44s | All 3 errored — **AI Gateway ran out of credits** mid-run (not a CLI bug); see [§4](#4-the-run-1-failures-were-billing-not-a-cli-bug) |
| 2 | `results-oxagen/2026-06-27__18-54-46` | Oxagen 0.6.1 | 2 | 2 | 0 | 0.0 ×2 | 17m 09s | Clean run; agent completed but verifier failed |
| 3 | `results-claude/2026-06-27__18-58-03` | Claude Code | 2 | 2 | 0 | 0.0 ×2 | 11m 46s | Clean run; verifier failed; cost $1.66 |

---

## 3. What actually happened inside the runs

The reward was 0 everywhere, but the agents were **not** idle — the trajectory logs show genuine attempts. Note the two distinct zero causes: **run #2 and Claude Code scored 0 by failing the verifier** (a real task result); **run #1's three zeros were billing errors** — the Vercel AI Gateway ran out of credits mid-run (see [§4](#4-the-run-1-failures-were-billing-not-a-cli-bug)), so those were never fair attempts.

- **Oxagen on `gpt2-codegolf`:** wrote `/app/gpt2.c`, compiled it with `gcc -O3 gpt2.c -lm` (succeeded), then measured the binary at **25,152 bytes** — over the 5,000-byte limit — and was iterating on size. In run #1 the turn then threw when the Gateway hit zero credits; in run #2 it ran to completion and scored 0. The pre/post pipeline is visible in the log: `evaluated · completeness 35/100 · complexity 75/100 · claude-haiku-4-5` → `enhanced · no extra context found` → `model · Sonnet (claude-sonnet-4.5) · pinned model` → `executing`.
- **Oxagen on `llm-inference-batching-scheduler`:** read the inputs, the cost model, and the baseline packer, then computed alignment math and a packing strategy (`completeness 85/100 · complexity 75/100`). In run #2 (clean) it did not clear the cost/pad/latency thresholds.
- **Oxagen on `break-filter-js-from-html`** (run #1 only): analyzed `filter.py`'s strip logic and reasoned about a parser-differential bypass before the turn threw on the Gateway credit error.
- **Claude Code:** completed both tasks cleanly, also scoring 0 — confirming these tasks are hard for the model itself, independent of harness.

**Interpretation:** on the clean comparison (Oxagen run #2 vs. Claude Code, same model Sonnet 4.5), both agents failed the same two hard tasks. The Oxagen-specific pre-processing (cost-router tiering, prompt enhancement) ran as designed and added no errors, but on this slice it also produced no wins — there was nothing in memory/code-graph to draw on (a cold agent, `enhanced · no extra context found`), which is exactly the condition the self-improvement thesis predicts should be *weakest*.

---

## 4. The run-#1 failures were billing, not a CLI bug

> **Correction.** An earlier version of this doc called run #1 a "CLI exit-code defect." That was a misdiagnosis. Reading the captured agent logs shows the real cause, and the CLI behaved correctly.

Run #1 (`18-35-47`) recorded **3/3 errored trials**, all surfaced by Harbor as `NonZeroAgentExitCodeError` (Harbor flags any non-zero exit of the agent command as a trial *error*). The captured agent output (`results-oxagen/2026-06-27__18-35-47/*/agent/oxagen.txt`) shows the actual error, identical in all three trials:

```
Error: AI Gateway has no credit balance — every request (including BYOK) needs
credits. Add them to your Vercel AI Gateway account, then retry.
```

**Root cause: the Vercel AI Gateway account ran out of credits mid-run.** The sequence:

1. The agent's first model call(s) succeeded — which is why the logs show it writing and compiling `gpt2.c`, analyzing `filter.py`, etc.
2. A later model call returned `insufficient_funds` / `positive credit balance` from the Gateway.
3. `apps/cli/src/agent/loop.ts:137` (`normalizeAgentError`) deliberately translates that into the friendly "no credit balance" message.
4. The turn **threw** that error; `apps/cli/src/repl/one-shot.ts:103–111` caught it, wrote `Error: …` to stderr, and set `process.exitCode = 1`.
5. The process exited 1 → Harbor raised `NonZeroAgentExitCodeError`.

**The non-zero exit was correct, intentional behavior.** In `one-shot.ts` the headless path sets `exitCode = 1` *only* inside the `catch` block — i.e. only when the turn throws. A headless coding agent that cannot finish because its billing account is empty *should* exit non-zero and print why; that is exactly what happened. There is **no exit-code bug in the CLI** — nothing to fix in that path.

Run #2 (`18-54-46`), 19 minutes later, recorded **0 errored / 2 completed** — the Gateway balance had been topped up, so the same two tasks ran to completion (and then scored 0 by failing the verifier, a genuine result).

The one worthwhile follow-up is on the **benchmark adapter**, not the CLI: a billing/API failure (no credits, 401, 429) should be distinguished from a real task failure, ideally with a pre-flight Gateway-balance check, so a dead-credits run never masquerades as an agent error. Tracked in [§6](#6-follow-ups-this-run-surfaced).

---

## 5. Caveats — why this proves nothing (yet)

This run is honest baseline-setting. Measured against the standards in [`eval-runbook.md`](./eval-runbook.md), it falls short on nearly every axis required for a real comparison — by design, because it was a smoke test:

1. **n = 2 tasks, 1 attempt each.** Statistically meaningless — far below the ≥300 instance-runs per arm the runbook's power analysis calls for. A 0–0 tie on 2 tasks is consistent with the agents being equal, better, or worse.
2. **Hardest-task selection bias.** Both tasks sit at the difficult tail of TB2. A 0% slice says little about the full distribution; many TB2 tasks are solvable and would separate the agents.
3. **Route confound.** Oxagen ran through the **Vercel AI Gateway**; Claude Code ran **direct to Anthropic**. Same model (Sonnet 4.5), but different routing, rate-limits, and possibly different system-prompt scaffolding from each adapter. The runbook requires an identical route on every arm.
4. **No ablation.** The graphs (code / execution / memory) were not toggled. This run does **not** test the self-improvement thesis at all — and the agent was cold (`no extra context found`), the condition under which the thesis predicts the *least* benefit.
5. **Token/cost not captured for Oxagen.** Without it there is no cost-normalized comparison (Claude Code: $1.66 for the pair; Oxagen: unknown).
6. **Single seed.** No repeats to average over model nondeterminism.

**Bottom line:** the value of this run is (a) the Harbor adapter and standalone bundle work end-to-end against real TB2 containers, (b) a reproducible head-to-head harness now exists, and (c) it surfaced one real adapter gap (token/cost not captured) plus an operational lesson (keep the Gateway funded; the run-#1 "errors" were billing, not a code defect — [§4](#4-the-run-1-failures-were-billing-not-a-cli-bug)). It is the *starting point* for the protocol in the runbook, not evidence for it.

---

## 6. Follow-ups this run surfaced

| # | Issue | Where | Fix |
|---|---|---|---|
| 1 | Run #1's 3 errors were the **AI Gateway out of credits** mid-run, surfaced (correctly) as a non-zero exit → Harbor scored them as errors. **Not a CLI bug** — the exit code was correct. | Gateway billing; `apps/cli/src/agent/loop.ts:137` + `one-shot.ts:103`. | Operational: keep the Gateway funded. Adapter: add a pre-flight balance check and classify billing/API failures (no-credits, 401, 429) distinctly from task failures so they don't masquerade as agent errors. |
| 2 | Adapter reports `null` tokens/cost for Oxagen, blocking cost-normalized comparison. | `bench/terminal-bench/src/oxagen_terminal_bench/oxagen_agent.py` (`agent_result`). | Surface Oxagen's per-run token/cost (it meters via `invoke()`/ClickHouse) through the adapter's `agent_result`. |
| 3 | Route asymmetry (Gateway vs Anthropic-direct). | Adapter `extra_allowed_hosts`. | For a fair comparison, run **both** agents through the **same** route/model id (see runbook §6.1). |
| 4 | Only 2 hard tasks, 1 seed. | Run config. | Scale to a representative TB2 subset × ≥5 seeds before drawing any conclusion (runbook §8). |

---

## 7. How to reproduce

From `bench/terminal-bench/` (Harbor 0.16.0, Python ≥3.13, Docker running):

```bash
# 1. Build the standalone CLI bundle the adapter ships into the container
pnpm --filter @oxagen/cli bundle          # -> apps/cli/dist-standalone/oxagen.mjs

# 2. Run Oxagen on the two tasks (Harbor invokes the OxagenAgent adapter)
harbor run \
  --agent oxagen_terminal_bench:OxagenAgent \
  --model anthropic/claude-sonnet-4.5 \
  --dataset terminal-bench==2.0 \
  --task gpt2-codegolf --task llm-inference-batching-scheduler \
  --jobs-dir results-oxagen

# 3. Run Claude Code on the same two tasks for the head-to-head
harbor run \
  --agent claude-code \
  --model anthropic/claude-sonnet-4-5 \
  --dataset terminal-bench==2.0 \
  --task gpt2-codegolf --task llm-inference-batching-scheduler \
  --jobs-dir results-claude

# 4. Inspect
harbor view results-oxagen
```

> Exact CLI flags follow Harbor 0.16.0; the captured runs were produced with the config recorded in each run's `config.json`. The adapter resolves the bundle from `apps/cli/dist-standalone/oxagen.mjs` or `OXAGEN_CLI_BUNDLE=/abs/path/to/oxagen.mjs`.

---

## 8. Raw artifacts

- **Oxagen, clean run:** `bench/terminal-bench/results-oxagen/2026-06-27__18-54-46/` (`result.json`, per-trial `*/result.json`, `*/agent/`, `*/verifier/`)
- **Oxagen, errored run:** `bench/terminal-bench/results-oxagen/2026-06-27__18-35-47/`
- **Claude Code:** `bench/terminal-bench/results-claude/2026-06-27__18-58-03/`
- **Console logs:** `bench/terminal-bench/{oxagen-run.log, oxagen-run2.log, claude-run.log}`
- **Adapter source:** `bench/terminal-bench/src/oxagen_terminal_bench/`
