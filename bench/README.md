# Harbor Benchmark Suite

Quick benchmark runner for SWE-bench with Stella CLI and Oxagen CLI.

## Quick Start

```bash
# From repo root
cd bench

# Run 10 random tasks with Stella GLM (default)
./run-10-random.sh

# Run 5 tasks with Oxagen Claude Sonnet 5
./run-10-random.sh --agent oxagen --tasks 5

# Compare Stella vs Oxagen on same tasks
./run-10-random.sh --compare --tasks 5 --concurrent 1

# Run with higher budget and parallelism
./run-10-random.sh --budget 15 --concurrent 4
```

## Configuration

### Stella CLI (GLM Models)

Stella uses the ZAI platform for GLM models. The default is `zai/glm-5.2`, the most powerful GLM model currently available.

```bash
# Environment variables for Stella
export ZAI_API_KEY=...           # Required for ZAI GLM models
export STELLA_BASE_URL="https://api.z.ai/api/coding/paas/v4"
export STELLA_MODEL="zai/glm-5.2"     # Most powerful GLM
export STELLA_BUDGET=10            # Per-task USD cap
export STELLA_BINARY="$HOME/Workspaces/stella-cli/target/release/stella"
```

### Oxagen CLI (Claude Models)

```bash
# Environment variables for Oxagen
export AI_GATEWAY_API_KEY=...      # For AI Gateway routing
export ANTHROPIC_API_KEY=...      # Direct Anthropic access
export OXAGEN_MODEL_SLUG="anthropic/claude-sonnet-5"  # Or opus-4.8, fable-5
export OXAGEN_CLI_BUDGET=10       # Per-task USD cap
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--agent <name>` | Agent: `stella`, `oxagen`, `claude-code` | `stella` |
| `--compare` | Run both stella + oxagen on same tasks | - |
| `--tasks <n>` | Number of random tasks | `10` |
| `--budget <usd>` | Per-task budget cap | `10` |
| `--concurrent <n>` | Parallel tasks | `2` |
| `--dataset <slug>` | Harbor dataset | `swe-bench/swe-bench-verified` |

## Task Pool

The script randomly selects from a curated pool of 50 diverse SWE-bench Verified tasks spanning:
- **Repositories**: Django, SymPy, Matplotlib, Astropy, Flask, Seaborn, Pylint, Pytest, Scikit-learn, Pandas, NumPy, Requests
- **Difficulty**: Easy smoke tests to complex bug fixes
- **Domains**: Web frameworks, scientific computing, data science, testing tools

## Model Comparison

### Stella GLM (zai/glm-5.2)
- **Provider**: ZAI (z.ai)
- **Strengths**: Optimized for coding tasks, fast iteration
- **Cost**: Generally more cost-effective than Claude Opus

### Oxagen Claude (anthropic/claude-sonnet-5)
- **Provider**: Anthropic via AI Gateway
- **Strengths**: Strong reasoning, good for complex bugs
- **Alternatives**: `claude-opus-4.8` (more powerful), `claude-fable-5` (faster/cheaper)

## Results

Results are saved in `bench/swe-bench/results-<agent>/` with:
- `bench-config.json` - Run configuration snapshot
- `<job-name>/config.json` - Harbor job config
- `<job-name>/trials/*.json` - Per-trial results

## Examples

```bash
# Smoke test - 3 easy tasks
./run-10-random.sh --tasks 3 --budget 5

# Full comparison - 10 tasks, both agents
COMPARE_WITH_CLAUDE=true ./run-10-random.sh

# High budget, more parallelism
./run-10-random.sh --budget 20 --concurrent 4 --agent oxagen

# Use Claude Opus for Oxagen
OXAGEN_MODEL_SLUG=anthropic/claude-opus-4.8 ./run-10-random.sh --agent oxagen
```

## Advanced Usage

For more control, use the underlying `bench/swe-bench/run.sh` directly:

```bash
cd bench/swe-bench

# Single task with specific model
TASK_IDS="django__django-11099" \
OXAGEN_MODEL_SLUG=anthropic/claude-opus-4.8 \
AGENT=oxagen \
./run.sh

# Full dataset run
AGENT=stella \
N_CONCURRENT=4 \
./run.sh
```
