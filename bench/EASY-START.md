# Harbor SWE-bench - Quick Start Guide

Easy benchmark runner for Oxagen and Stella CLIs with cost controls.

## One-Line Setup

```bash
# Clone and navigate (if not already in oxagen-platform)
cd ~/Workspaces/oxagen-platform/bench

# Set up API keys
export AI_GATEWAY_API_KEY=...      # For Oxagen
export ZAI_API_KEY=...             # For Stella
```

## Run Benchmarks

### Run Oxagen (smoke test, ~$5-10)
```bash
./run-easy.sh oxagen
```

### Run Stella (smoke test, ~$5-10)
```bash
./run-easy.sh stella
```

### Run Both (sequentially, ~$10-20 total)
```bash
./run-easy.sh both
```

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `BUDGET` | `25` | Total USD per agent |
| `N_CONCURRENT` | `1` | Parallel tasks |
| `TASK_IDS` | 3 smoke tasks | Which SWE-bench tasks to run |

### Examples

```bash
# Increase budget to $50
BUDGET=50 ./run-easy.sh oxagen

# Run a single task
TASK_IDS="django__django-11099" ./run-easy.sh stella

# Run 5 tasks in parallel
N_CONCURRENT=5 ./run-easy.sh oxagen
```

## Default Smoke Tasks

The default `TASK_IDS` are three well-known SWE-bench instances:
- `django__django-11099` — Django ORM issue
- `django__django-11051` — Django admin issue
- `sympy__sympy-23813` — SymPy symbolic math issue

These provide a quick validation that the agent works on real codebases.

## What It Does

For each agent and each task:
1. Clones the target repo at a specific commit
2. Runs the agent one-shot with the issue description
3. Collects the resulting git diff
4. Runs the repo's test suite to verify the fix
5. Reports pass/fail + cost/token metrics

## Cost Estimates

| Agent | Per Task | 3 Tasks | 10 Tasks |
|-------|----------|---------|----------|
| Oxagen (Sonnet 5) | ~$3-5 | ~$10-15 | ~$30-50 |
| Stella (GLM 5.2) | ~$0.01-0.05 | ~$0.05-0.15 | ~$0.1-0.5 |

*Stella with Z.ai is significantly cheaper.*

## Results

Results are written to:
- Oxagen: `~/Workspaces/oxagen-platform/bench/swe-bench/results-oxagen/`
- Stella: `~/Workspaces/stella-cli/bench/harbor_adapter/results-stella/`

## Troubleshooting

**"pip not found"**
```bash
# The script uses python3 -m pip, which works on most systems
# If you have issues, ensure Python 3 is installed:
python3 --version
```

**"Cannot find Harbor runner"**
```bash
# Ensure you're in the oxagen-platform/bench directory
cd ~/Workspaces/oxagen-platform/bench
./run-easy.sh oxagen
```

**"API key not set"**
```bash
# For Oxagen:
export AI_GATEWAY_API_KEY=...

# For Stella:
export ZAI_API_KEY=...
export STELLA_BASE_URL=https://api.z.ai/api/coding/paas/v4
```

## Full SWE-bench Verified

To run the full 500-task dataset (expensive!):

```bash
cd ~/Workspaces/oxagen-platform/bench/swe-bench

# Oxagen (~$1500-2500)
export AI_GATEWAY_API_KEY=...
AGENT=oxagen ./run.sh

# Stella (~$5-50, depending on Z.ai pricing)
export ZAI_API_KEY=...
cd ~/Workspaces/stella-cli/bench/harbor_adapter
./run.sh
```
