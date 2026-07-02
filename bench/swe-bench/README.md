# Oxagen × SWE-bench (Harbor)

Benchmark the **Oxagen coding CLI** on [SWE-bench](https://www.swebench.com)
via the [Harbor](https://www.harborframework.com/) harness, head-to-head with
Claude Code, Codex CLI, Aider, OpenHands, and other Harbor-supported agents.

```
bench/swe-bench/
├── run.sh                             # one-command: build bundle → harbor run
├── compare.sh                         # run oxagen + N competitors on the same dataset/model
├── emit_eval_json.py                  # thin CLI wrapper → oxagen_terminal_bench.eval_normalize
├── pyproject.toml                     # adapter package (deps: harbor, oxagen-terminal-bench)
├── tests/test_emit.py                 # unit test for the normalizer's schema + resolved-rate math
├── results/                           # shared normalized *.eval.json output (git-ignored)
└── src/oxagen_swe_bench/
    └── __init__.py                    # re-exports oxagen_terminal_bench.OxagenAgent
```

This adapter does **not** duplicate the Terminal-Bench installer/runner logic.
From Harbor's point of view a SWE-bench task is the same shape as a
Terminal-Bench task (an installed agent, a working directory, an instruction,
a verifier that decides pass/fail afterward) — so
`oxagen_swe_bench.OxagenAgent` is a plain re-export of
[`oxagen_terminal_bench.OxagenAgent`](../terminal-bench/src/oxagen_terminal_bench/oxagen_agent.py).
See that package's README for the full install()/run() mechanics, warm mode,
and DuckDB context-engine notes — they apply here unchanged.

## What this measures

**Resolved-rate on the official SWE-bench dataset, decided by the
authoritative Harbor verifier** — not self-grading. For each task instance,
Harbor:

1. Checks out the target repo at the pre-fix commit inside a container.
2. Gives the agent the issue text and lets it edit the repo.
3. Applies the agent's patch and runs **the repo's own real test suite**
   (the official SWE-bench `FAIL_TO_PASS` / `PASS_TO_PASS` test lists) to
   decide pass/fail. The agent has no way to see or influence the verifier.

Background reading:
- [SWE-bench paper](https://arxiv.org/abs/2310.06770) — the original benchmark.
- [SWE-bench Verified](https://openai.com/index/introducing-swe-bench-verified/) —
  OpenAI's human-filtered subset removing under-specified/unsolvable instances.
  This is the default dataset here (`DATASET=swe-bench/swe-bench-verified`, the
  namespaced slug published on the [Harbor Hub](https://hub.harborframework.com/datasets)).
- [Official leaderboard](https://www.swebench.com) — third-party submitted
  numbers; see "Fairness & methodology" below for why we don't cite these as
  directly comparable to our own runs.
- [Terminal-Bench](https://www.tbench.ai/) — the sibling harness this package
  mirrors (`bench/terminal-bench/`), for general agentic terminal tasks rather
  than repo-fix tasks specifically.

## Prerequisites

- **Docker** running.
- **uv** (`curl -LsSf https://astral.sh/uv/install.sh | sh`).
- **pnpm** + the monorepo (this repo) — to build the Oxagen bundle (only
  needed when `AGENT=oxagen`).
- **`AI_GATEWAY_API_KEY`** exported — required only for `AGENT=oxagen`
  (Oxagen routes every LLM call through the Vercel AI Gateway). Competitor
  agents (`claude-code`, `codex`, `aider`, ...) need their own provider keys
  instead (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) — see each agent's own
  docs; this repo does not manage those keys.

## Quick start

```bash
cd bench/swe-bench

export AI_GATEWAY_API_KEY=...           # from repo .env.local (AGENT=oxagen only)

# Smoke-test a single instance first (fast, ~1 container):
TASK_IDS="django__django-11099" N_CONCURRENT=1 ./run.sh

# Full SWE-bench Verified, oxagen, default model:
AGENT=oxagen ./run.sh

# Cheap smoke test — a single instance (skips the full 500-task run):
TASK_IDS="django__django-11099" N_CONCURRENT=1 ./run.sh

# A different Harbor dataset (browse https://hub.harborframework.com/datasets):
DATASET=swe-bench/swe-smith ./run.sh

# Pin a different base model:
OXAGEN_MODEL_SLUG=anthropic/claude-opus-4.8 ./run.sh

# Multi-vendor comparison (oxagen + claude-code + codex + aider, same model):
./compare.sh
```

## Multi-vendor comparison

```bash
./compare.sh                                   # default: claude-code codex aider
COMPETITORS="claude-code codex" ./compare.sh   # narrower set
OXAGEN_MODEL_SLUG=anthropic/claude-opus-4.8 ./compare.sh
TASK_IDS="django__django-11099" N_CONCURRENT=1 ./compare.sh   # cheap smoke run
```

`compare.sh` runs each agent **sequentially** on the same `DATASET` and the
same `OXAGEN_MODEL_SLUG` (passed to every agent's `-m` flag where that agent
supports pinning a model), emits a normalized `swe-bench.eval.json` for each
into `results-<agent>/<run>/`, copies each into the shared `results/` dir, and
prints a summary table of resolved-rate per agent.

## Fairness & methodology

**A comparison is only apples-to-apples when the dataset, harness, and
underlying model are held constant.** `compare.sh` does exactly that: same
`DATASET`, same Harbor verifier, same `OXAGEN_MODEL_SLUG` passed to every
agent's model flag.

Oxagen is **a scaffold on top of a base model** — planning, tool selection,
context engineering, and (optionally) a cost-aware router sit on top of
whatever model you pin. So the fair claim from a `compare.sh` run is:

> "Oxagen's scaffold on model X resolved N% of SWE-bench Verified vs. agent Y's
> scaffold on the same model X."

That is a claim about **scaffold quality**, not raw model capability — and it
is the only claim these local runs support. It is explicitly **not** the same
as citing a number from the [official leaderboard](https://www.swebench.com):
leaderboard entries are third-party submissions that may use different
models, different prompts, different task subsets (some report on Lite,
some on Verified, some on the full set), and different retry/attempt budgets.
Never present a leaderboard number and a `compare.sh` number in the same table
without labeling which is which — mixing them implies a controlled comparison
that didn't happen.

## Configuration (env vars)

| Var | Default | Effect |
|---|---|---|
| `AGENT` | `oxagen` | `oxagen` uses the external adapter; any other value (`claude-code`, `codex`, `aider`, `openhands`, `gemini-cli`, `swe-agent`, `oracle`, `nop`, ...) is passed to Harbor's `--agent` as a built-in. |
| `AI_GATEWAY_API_KEY` | — (required when `AGENT=oxagen`) | Forwarded into the container for all Oxagen LLM calls. |
| `OXAGEN_MODEL_SLUG` | `anthropic/claude-sonnet-4.5` | Model passed to Harbor `-m` (an AI-Gateway slug for oxagen; a provider-native model id for most competitors). |
| `OXAGEN_ROUTE` | unset | `1` → (oxagen only) drop `--model`; Oxagen's cost-aware router chooses per task. |
| `OXAGEN_NO_PIPELINE` | unset | `1` → (oxagen only) skip prompt-eval / context-injection / completeness-judge. |
| `OXAGEN_INSTALL_DUCKDB` | unset | `1` → (oxagen only) also install DuckDB so the context engine's persistent stores are live. |
| `OXAGEN_WARM` / `OXAGEN_WARM_MEMORY_DIR` | unset | Cross-trial memory persistence (oxagen only) — see the terminal-bench README's "Warm / self-improvement mode". |
| `OXAGEN_CLI_BUNDLE` | repo build path | Override the path to `oxagen.mjs` (oxagen only). |
| `DATASET` | `swe-bench/swe-bench-verified` | Any Harbor dataset slug from [the Hub](https://hub.harborframework.com/datasets) (e.g. `swe-bench/swe-smith`, `scale-ai/swe-bench-pro`). |
| `TASK_IDS` | — | Space-separated task ids, expanded to repeated `--include-task-name` flags (smoke-testing a subset). |
| `N_CONCURRENT` / `N_ATTEMPTS` | `4` / `1` | Parallelism and attempts per task. |
| `JOBS_DIR` | `./results-$AGENT` | Where Harbor writes per-trial output. |
| `HARBOR_EXTRA` | — | Extra raw flags (e.g. `--env daytona`). |
| `COMPETITORS` (compare.sh only) | `claude-code codex aider` | Space-separated list of Harbor built-in agents to run alongside oxagen. |

`OXAGEN_ALLOW_NO_SESSION=1` is exported automatically by `run.sh` — the
Oxagen CLI normally requires a logged-in session
(`requireSession()` in `apps/cli/src/lib/session.ts`) and `exit(1)`s without
one; benchmark containers never log in, so this flag makes it return a
synthetic `{token: "benchmark-token", orgSlug: "benchmark", ...}` session
instead. It has no effect on competitor agents.

## How results flow to the dashboard

```
harbor run  →  results-<agent>/<run>/result.json (+ per-trial result.json)
            →  emit_eval_json.py  →  swe-bench.eval.json  (oxagen.eval.v1 schema)
                                  →  results/<agent>-<run_id>.eval.json  (shared copy)
            →  pnpm eval:ingest bench/swe-bench/results/*.eval.json
            →  ClickHouse eval_runs / eval_results
            →  bench/web dashboard
```

The `oxagen.eval.v1` schema is shared with `bench/terminal-bench` — both
harnesses call the same
[`oxagen_terminal_bench.eval_normalize.build_eval_json`](../terminal-bench/src/oxagen_terminal_bench/eval_normalize.py)
function with a different `harness` argument, so field names never drift
between the two, and `tools/scripts/eval-ingest.ts` ingests both without
special-casing either.

## Results

Written under `--jobs-dir` (default `./results-$AGENT/`) and the shared
`./results/` dir, both git-ignored.
