# Oxagen × Terminal-Bench (Harbor)

Benchmark the **Oxagen coding CLI** on [Terminal-Bench](https://www.tbench.ai/)
via the [Harbor](https://www.harborframework.com/) harness, head-to-head with
Claude Code, Codex CLI, OpenHands, and friends.

This is a Harbor **external agent** ([`--agent-import-path`](https://www.harborframework.com/docs/agents#external-agents))
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
HARBOR_EXTRA="--task-id hello-world" N_CONCURRENT=1 ./run.sh

# Full Terminal-Bench, pinned model, 4 in parallel:
OXAGEN_MODEL_SLUG=anthropic/claude-opus-4.8 ./run.sh
```

`run.sh` builds the bundle, creates a venv, installs Harbor + this adapter
(editable), and invokes:

```bash
uv run harbor run \
  -d terminal-bench@2.0 \
  --agent-import-path oxagen_terminal_bench:OxagenAgent \
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
  --agent-import-path oxagen_terminal_bench:OxagenAgent \
  -m anthropic/claude-sonnet-4.5 -n 4
```

## Apples-to-apples vs Claude Code

Run both agents through the **same Harbor + dataset + model**, then compare pass
rate (and cost/latency):

```bash
# Oxagen
uv run harbor run -d terminal-bench@2.0 --agent-import-path oxagen_terminal_bench:OxagenAgent -m anthropic/claude-opus-4.8 -n 4
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
| `OXAGEN_ROUTE` | unset | `1` → drop `--model`; Oxagen's cost-aware router chooses per task. |
| `OXAGEN_NO_PIPELINE` | unset | `1` → skip prompt-eval / context-injection / completeness-judge (leaner, cheaper). Default keeps the full Oxagen scaffold on. |
| `OXAGEN_INSTALL_DUCKDB` | unset | `1` → also `npm i` DuckDB so the context engine's persistent memory/trace stores are live. |
| `OXAGEN_CLI_BUNDLE` | repo build path | Override the path to `oxagen.mjs`. |
| `DATASET` | `terminal-bench@2.0` | Any Harbor dataset slug. |
| `N_CONCURRENT` / `N_ATTEMPTS` | `4` / `1` | Parallelism and attempts per task. |
| `HARBOR_EXTRA` | — | Extra raw flags (e.g. `--task-id <id>`, `--env daytona`). |

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
   `--mode bypass --verbose`, teeing output to `/logs/agent/oxagen.txt`.
3. Harbor runs the task's verifier against the resulting container state and
   records the reward.

## Results

Written under `--jobs-dir` (default `./oxagen-tbench-results/`), git-ignored.
