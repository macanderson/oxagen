# Oxagen × Terminal-Bench (Harbor)

Benchmark the **Oxagen coding CLI** on [Terminal-Bench](https://www.tbench.ai/)
via the [Harbor](https://www.harborframework.com/) harness, head-to-head with
Claude Code, Codex CLI, OpenHands, and friends.

This is a Harbor **external agent** ([`--agent <module.path:ClassName>`](https://www.harborframework.com/docs/agents#external-agents))
that implements `BaseInstalledAgent`. It installs Oxagen into each task container
and runs it headlessly, fully autonomous (`--mode bypass`: file edits + shell, no
human in the loop).

```
bench/terminal-bench/
├── run.sh                                  # one-command: build bundle → harbor run
├── pyproject.toml                          # adapter package (dep: harbor)
└── src/oxagen_terminal_bench/
    ├── __init__.py
    └── oxagen_agent.py                     # OxagenAgent(BaseInstalledAgent)
```

## Why a bundle instead of `npm i -g @oxagen/cli`

The published `@oxagen/cli` is **not** standalone-installable today: its
`dependencies` still carry `@oxagen/engram: workspace:*` (the pnpm workspace
protocol leaked into the publish) while those internal packages are unpublished,
and the bin shebang is `#!/usr/bin/env tsx`. So `npm i -g @oxagen/cli` fails in a
clean container.

Instead we ship a **self-contained single-file bundle** built with esbuild
(`pnpm --filter @oxagen/cli bundle` → `apps/cli/dist-standalone/oxagen.mjs`) and
`upload_file` it into the task container. The bundle inlines all `@oxagen/*` and
npm deps and runs under plain `node` — nothing else to resolve.
(See [OXA — fix the npm publish] in Linear to make `npm i -g @oxagen/cli` work
permanently; the bundle doubles as that fix.)

## Prerequisites

- **Docker** running.
- **uv** (`curl -LsSf https://astral.sh/uv/install.sh | sh`).
- **pnpm** + the monorepo (this repo) — to build the bundle.
- **`AI_GATEWAY_API_KEY`** exported — Oxagen routes every LLM call through the
  Vercel AI Gateway. The task container needs network egress to the gateway
  (Terminal-Bench's default network policy allows model-provider egress; if you
  tightened it, allowlist the gateway host).

## Quick start

```bash
cd bench/terminal-bench

export AI_GATEWAY_API_KEY=...           # from repo .env.local

# Smoke-test a single task first (fast, ~1 container):
HARBOR_EXTRA="--include-task-name *hello-world" N_CONCURRENT=1 ./run.sh

# Full Terminal-Bench, pinned model, 4 in parallel:
OXAGEN_MODEL_SLUG=anthropic/claude-opus-4.8 ./run.sh

# Best-of-N differentiator (3 candidates/task, judge picks the winner) — see "Best-of-N mode":
OXAGEN_BEST_OF_N=1 OXAGEN_BEST_OF_N_CANDIDATES=3 ./run.sh
```

`run.sh` builds the bundle, creates a venv, installs Harbor + this adapter
(editable), and invokes:

```bash
uv run harbor run \
  -d terminal-bench@2.0 \
  --agent oxagen_terminal_bench:OxagenAgent \
  -m anthropic/claude-sonnet-4.5 \
  --n-concurrent 4 --n-attempts 1 \
  --jobs-dir ./oxagen-tbench-results
```

### Manual (without `run.sh`)

```bash
pnpm --filter @oxagen/cli bundle                 # → apps/cli/dist-standalone/oxagen.mjs
cd bench/terminal-bench
uv venv && source .venv/bin/activate
uv tool install harbor
uv pip install -e ".[dev]"
export AI_GATEWAY_API_KEY=...
export OXAGEN_CLI_BUNDLE="$(cd ../.. && pwd)/apps/cli/dist-standalone/oxagen.mjs"
uv run harbor run -d terminal-bench@2.0 \
  --agent oxagen_terminal_bench:OxagenAgent \
  -m anthropic/claude-sonnet-4.5 -n 4
```

## Apples-to-apples vs Claude Code

Run both agents through the **same Harbor + dataset + model**, then compare pass
rate (and cost/latency):

```bash
# Oxagen
uv run harbor run -d terminal-bench@2.0 --agent oxagen_terminal_bench:OxagenAgent -m anthropic/claude-opus-4.8 -n 4
# Claude Code (built into Harbor)
uv run harbor run -d terminal-bench@2.0 --agent claude-code -m anthropic/claude-opus-4.8 -n 4
```

To showcase Oxagen's **cost-aware router** instead of a pinned model, add
`OXAGEN_ROUTE=1` (the adapter drops `--model` so Oxagen picks Haiku/Sonnet/Opus
per task) and compare cost at similar pass rate.

## Configuration (env vars)

| Var | Default | Effect |
|---|---|---|
| `AI_GATEWAY_API_KEY` | — (required) | Forwarded into the container for all LLM calls. |
| `OXAGEN_MODEL_SLUG` | `anthropic/claude-sonnet-4.5` | Model passed to Harbor `-m` (an AI-Gateway slug). |
| `OXAGEN_ROUTE` | unset | `1` → drop `--model`; Oxagen's cost-aware router chooses per task (or per candidate, under best-of-N). |
| `OXAGEN_BEST_OF_N` | unset | `1` → run `oxagen solve --candidates <N> [--model X] "<task>"` instead of a single one-shot turn: N independent candidates, a comparative judge picks the winner, its diff is applied to the container's working directory. See "Best-of-N mode" below. |
| `OXAGEN_BEST_OF_N_CANDIDATES` | `3` | Candidates per task under `OXAGEN_BEST_OF_N=1`. |
| `OXAGEN_NO_PIPELINE` | unset | `1` → skip prompt-eval / context-injection / completeness-judge (leaner, cheaper). Default keeps the full Oxagen scaffold on. No effect under `OXAGEN_BEST_OF_N=1` (`solve` candidates already run bare). |
| `OXAGEN_INSTALL_DUCKDB` | unset | `1` → also `npm i` DuckDB so the context engine's persistent memory/trace stores are live. |
| `OXAGEN_CLI_BUNDLE` | repo build path | Override the path to `oxagen.mjs`. |
| `DATASET` | `terminal-bench@2.0` | Any Harbor dataset slug. |
| `N_CONCURRENT` / `N_ATTEMPTS` | `4` / `1` | Parallelism and attempts per task. |
| `HARBOR_EXTRA` | — | Extra raw flags (e.g. `--include-task-name *<id>`, `--env daytona`). |

### Is DuckDB important here?

DuckDB powers Oxagen's **context engine** (the local knowledge-graph replica from
`oxagen graph pull`, episodic/session + fleet memory, the trace store, and the
daemon's persistent state). In a **cold benchmark trial** none of that is
load-bearing: the task container is a fresh, unknown repo with no pre-pulled
graph snapshot and no prior sessions to recall, and a trial is a single one-shot
run. The agent's actual work — read/edit/grep/bash plus the pipeline's
prompt-eval, context-injection and completeness-judge — runs fully without it;
the DuckDB-backed stores degrade gracefully when the module is absent (verified:
the full loop completes a file-editing task with zero DuckDB errors). DuckDB is
therefore left **external** in the bundle. Set `OXAGEN_INSTALL_DUCKDB=1` to make
it live in-container if you want to measure the full context engine.

## How it works (per task)

1. **install()** — installs Node 22 (NodeSource/apk), `upload_file`s the bundle
   to `/usr/local/lib/oxagen/oxagen.mjs`, drops a `/usr/local/bin/oxagen`
   `node`-wrapper, and verifies `oxagen --version`.
2. **run()** — forwards `AI_GATEWAY_API_KEY` (+ any `OXAGEN_*`), then runs
   `oxagen <flags> "<instruction>"` in the task's working directory with
   `--mode bypass --verbose` (or, under `OXAGEN_BEST_OF_N=1`,
   `oxagen solve --candidates <N> [--model X] --json "<instruction>"` — see
   "Best-of-N mode" below), teeing output to `/logs/agent/oxagen.txt`.
3. Harbor runs the task's verifier against the resulting container state and
   records the reward.

## Best-of-N mode

`OXAGEN_BEST_OF_N=1` benchmarks Oxagen's best-of-N differentiator (`oxagen
solve`) instead of a single one-shot turn: N independent candidates each run
the full coding-agent loop in their own isolated git worktree, a comparative
judge scores them on their diff + test output, and the winner's diff is
applied to the container's real working directory — so the container's
resulting `git diff` (what Harbor's verifier grades) is exactly the winning
candidate's patch. Selection is entirely the comparative judge's call; the
adapter never passes a `--verify` command (Harbor's own verifier is external
and hidden from the agent — see `OXAGEN_FORBID_TEST_EDITS` above).

```bash
OXAGEN_BEST_OF_N=1 OXAGEN_BEST_OF_N_CANDIDATES=3 ./run.sh
# ...combine with routing to benchmark best-of-N + the cost-aware router together:
OXAGEN_BEST_OF_N=1 OXAGEN_ROUTE=1 ./run.sh
```

Notes:
- **Runs headless automatically.** `oxagen solve` renders a live multi-lane
  view on a real TTY, but this adapter's command always pipes `oxagen`'s
  stdout into `tee` (`... | stdbuf -oL tee /logs/agent/oxagen.txt`), so
  `process.stdout.isTTY` is `false` regardless of how Harbor itself execs the
  command — `solve` detects this and streams JSONL events instead of trying to
  mount an Ink UI. The adapter also passes `--json` explicitly, so this never
  silently depends on that auto-detection alone.
- **Cost is not yet tracked.** The single-turn path's `--verbose` flag prints a
  final efficiency roll-up (`815.53s total · 83086 tok · $0.2714`) that
  `populate_context_post_run()` parses into `context.cost_usd`. `solve` has no
  `--verbose` equivalent, and `best-of-n.ts` doesn't thread per-candidate token
  usage onto its `Candidate` type yet — so best-of-N trials leave
  `context.cost_usd` unset rather than reporting a fabricated number. The
  adapter still recovers `oxagen_bestofn_candidates`, `oxagen_bestofn_winner_id`,
  `oxagen_bestofn_winner_files`, `oxagen_bestofn_winner_steps`, and
  `oxagen_bestofn_failed_candidates` into `context.metadata` from the JSONL
  stream's trailing `type: "result"` line.
- **Model pinning applies to every candidate.** Harbor's `-m` becomes `solve
  --model <slug>` — all N candidates use the same benchmarked model (true
  best-of-N sampling), not a diversity mix across different models.

## Warm / self-improvement mode

The cold benchmark measures a single stateless trial — the agent starts with no
prior memory.  The warm mode persists Oxagen's memory/trace stores across trials
so each task benefits from lessons accumulated during earlier tasks.  This is the
experimental substrate for proving **H4** (self-improvement thesis) from
`docs/cli/eval-runbook.md §7`.

### How to run

```bash
# Warm: memory persists across all trials in the sequence
OXAGEN_WARM=1 ./run.sh

# Explicit warm-memory dir (default: ./warm-memory)
OXAGEN_WARM=1 OXAGEN_WARM_MEMORY_DIR=./warm-mem N_CONCURRENT=1 ./run.sh

# Cold baseline for comparison (default — every trial gets a fresh in-container HOME)
./run.sh
```

**Important:** use `N_CONCURRENT=1` for warm runs.  Parallel trials all write to
the same host-side warm dir simultaneously, causing races.  Serialized trials
(`N_CONCURRENT=1`) give clean, ordered memory accumulation.

### What it does

`run.sh` with `OXAGEN_WARM=1`:
1. Sets `OXAGEN_INSTALL_DUCKDB=1` so the DuckDB-backed context engine (episodic
   memory, fleet memory, trace store) is live in every container.
2. Sets `OXAGEN_WARM_MEMORY_DIR` (default `./warm-memory`) and creates it.
3. Passes both vars to Harbor, which forwards them as env vars to the adapter.

The adapter (`oxagen_agent.py`) then does the real cross-trial work:
- **`install()` (start of each trial):** if `OXAGEN_WARM_MEMORY_DIR` has content
  from prior trials, it uploads `<warm-dir>/.config/oxagen/` into the container
  at `_WARM_CONFIG_IN_CONTAINER` (`/tmp/oxa-warm-home/.config/oxagen/`).
- **`_forwarded_env()`:** sets `HOME=/tmp/oxa-warm-home` in the container env so
  all of Oxagen's `node:os.homedir()` calls resolve to that path (fleet memory,
  trace store, engram DuckDB, settings — all land under it).
- **`run()` (after the agent finishes):** downloads `/tmp/oxa-warm-home/.config/oxagen/`
  back to `<warm-dir>/.config/oxagen/` on the host, so the next trial inherits it.

### Why HOME is the relocation env var

The CLI has no `OXAGEN_HOME` or `XDG_CONFIG_HOME` variable.  Every path helper
calls `node:os.homedir()` directly, which on Linux/macOS reads `HOME`.  Setting
`HOME` in the forwarded env is therefore the complete relocation mechanism.
Confirmed in `apps/cli/src/agent/trace-store.ts`, `fleet/memory.ts`,
`memory.ts`, `settings/resolve.ts`, and the unit tests
(`apps/cli/src/agent/__tests__/fleet-memory.test.ts`).

### Cold vs warm comparison

Run a cold baseline then a warm sequence on the **same task set** with the
**same model**:

```bash
# Cold: N trials, each starting with empty HOME
./run.sh                            # default cold
# Warm: N trials, each starting with memory from all prior trials
OXAGEN_WARM=1 N_CONCURRENT=1 ./run.sh --jobs-dir ./warm-results
```

Compare `resolved@1` (pass rate) across the two jobs dirs.  A higher warm pass
rate is the learning signal.  For the causal test, wipe the warm dir and re-run:

```bash
rm -rf ./warm-memory && mkdir ./warm-memory
OXAGEN_WARM=1 N_CONCURRENT=1 ./run.sh --jobs-dir ./wiped-results
```

If the wiped warm pass rate drops back toward the cold baseline, the accumulated
memory caused the improvement (H4 causal clause).  If it does not drop, something
else drove the gain — report that honestly.

### Honest limitation

Harbor's default config deletes the container after each trial
(`environment.delete: true`).  The upload/download mechanism is real and
implemented — memory genuinely persists across trials on the same machine.

The remaining limitation: if Harbor workers run on **remote or ephemeral cloud
machines** (Novita, E2B, Daytona), `OXAGEN_WARM_MEMORY_DIR` on the host is not
the same machine as the container, so the download goes to the Harbor coordinator
host rather than the same path the next trial's `install()` will read from.  In
that configuration the warm loop silently breaks (each trial starts cold despite
the download succeeding to a coordinator-local path).

**Workaround for cloud Harbor:** mount a shared network volume (NFS, EFS, Blob) at
`OXAGEN_WARM_MEMORY_DIR` that is accessible from all Harbor workers.  Until then,
warm mode is fully functional only when running Harbor locally (the default
`docker` environment).

## Results

Written under `--jobs-dir` (default `./oxagen-tbench-results/`), git-ignored.
