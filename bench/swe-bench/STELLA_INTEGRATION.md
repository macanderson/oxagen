# Stella CLI SWE-bench Integration

**Status:** ✅ Complete — Adapter built and ready for benchmarking

## What was built

1. **Stella Agent Adapter** (`src/oxagen_swe_bench/stella_agent.py`)
   - Implements Harbor's `BaseInstalledAgent` for the Rust-based Stella CLI
   - Installs the static `stella` binary (no Node runtime required)
   - Calls `stella run` with `--output-format stream-json` for headless execution
   - Parses `AgentEvent` JSONL output for Harbor telemetry (cost, model, steps, files touched)

2. **Run Script** (`run_stella.sh`)
   - One-command SWE-bench runner for Stella
   - Builds the binary if not already built
   - Sets up Harbor with correct agent path (`oxagen_swe_bench:StellaAgent`)
   - Supports all standard options: `TASK_IDS`, `STELLA_MODEL`, `STELLA_BUDGET`, `DATASET`, `N_CONCURRENT`

3. **Documentation Updates**
   - Updated `README.md` with Stella quick start guide
   - Documented differences between Stella and TS CLI
   - Added adapter export to `__init__.py`

## Architecture

```
run_stella.sh
    ├─ Builds stella binary (cargo build --release -p oxagen-cli)
    ├─ Sets up Harbor venv
    └─ Runs: harbor run --agent oxagen_swe_bench:StellaAgent

StellaAgent (stella_agent.py)
    ├─ install(): Uploads stella binary to /usr/local/bin/stella
    ├─ run(): Executes stella run --output-format stream-json "<task>"
    └─ populate_context_post_run(): Parses AgentEvent JSONL for telemetry

Stella CLI (crates/oxagen-cli)
    └─ Emits AgentEvent protocol (crates/oxagen-protocol/src/event.rs)
```

## Usage

### Quick start (smoke test)

```bash
cd bench/swe-bench

# Build Stella (one-time)
cd ../../crates && cargo build --release -p oxagen-cli

# Set provider API key (BYOK — direct provider access)
export ANTHROPIC_API_KEY=sk-ant-...

# Run a single task to verify
TASK_IDS="django__django-11099" N_CONCURRENT=1 ./run_stella.sh
```

### Full SWE-bench Verified run

```bash
export ANTHROPIC_API_KEY=sk-ant-...  # or your provider key
./run_stella.sh
```

### With options

```bash
# Pin a specific model
STELLA_MODEL=zai/glm-5.2 ./run_stella.sh

# Set per-task budget cap
STELLA_BUDGET=5.0 ./run_stella.sh

# Run on a subset
TASK_IDS="django__django-11099 sympy__sympy-1234" N_CONCURRENT=2 ./run_stella.sh
```

## Key differences from TS CLI (`OxagenAgent`)

| Aspect | TS CLI (`oxagen`) | Stella CLI (`stella`) |
|--------|-------------------|------------------------|
| Runtime | Node.js 22 | Static binary (no runtime) |
| Bundle | `oxagen.mjs` + WASM files | Single `stella` binary |
| Command | `oxagen --mode bypass` | `stella run` |
| Model routing | AI Gateway | BYOK (direct provider) |
| Output | Ad-hoc text parsing | Stable `AgentEvent` protocol |
| Startup | ~109s (with bundle install) | <5s (single binary) |

## Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `STELLA_BINARY` | Path to pre-built binary | `crates/target/release/stella` |
| `STELLA_MODEL` | Worker model (provider/model_id) | `anthropic/claude-sonnet-5` |
| `STELLA_API_KEY` | Provider API key | (required, provider-specific) |
| `STELLA_BUDGET` | Per-task USD cap | none (unlimited) |
| `STELLA_OUTPUT_FORMAT` | Output format | `stream-json` (forced) |

## Provider credentials

Stella is BYOK — it talks directly to providers. Export the appropriate key:

```bash
# Anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
export OPENAI_API_KEY=sk-...

# Z.ai (GLM)
export ZAI_API_KEY=...

# Or set STELLA_API_KEY for the selected provider
```

## Results

Results are written to `results-stella/<job-name>/`:
- `bench-config.json` — Run configuration snapshot
- `result.json` — Harbor trial results (per-task)
- `swe-bench.eval.json` — Normalized eval results

## Telemetry

The adapter extracts the following from Stella's `AgentEvent` stream:

- `stella_model` — Model used for the task
- `stella_files_touched` — Number of files modified
- `stella_steps` — Execute stages (proxy for step count)
- `cost_usd` — Total cost (from `Complete` event)

## Next steps

To run the **full SWE-bench** with Stella:

1. Set your provider API key
2. Run: `./run_stella.sh`
3. Monitor progress in `results-stella/*/`
4. Results will be in `results-stella/<run>/swe-bench.eval.json`

For best-of-N or differentiated mode runs, Stella CLI currently supports the
basic `run` command. Extended features like best-of-N candidates would need
additional CLI support (planned for future phases per `docs/specs/oxagen-rust-cli/`).

## Files created/modified

- `bench/swe-bench/src/oxagen_swe_bench/stella_agent.py` — New adapter
- `bench/swe-bench/src/oxagen_swe_bench/__init__.py` — Updated to export both agents
- `bench/swe-bench/run_stella.sh` — New run script
- `bench/swe-bench/README.md` — Updated with Stella documentation
