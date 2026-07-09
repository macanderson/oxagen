# Pre-baked ("prewarmed") task images

Collapse the per-task agent setup — Node install + oxagen bundle/wasm upload +
ripgrep upload — by baking it all into the task image once, ahead of the run.

## Why

In the smoke run (`results-oxagen-smoke/2026-07-02__21-13-19`,
`django__django-11099`), the `agent_setup` phase took **~109s** — roughly a
quarter of trial wall time (see `bench/web/benchmark-findings.html`). Almost
all of it is repeated per trial: installing Node 22 via NodeSource inside the
container, then `docker compose cp`-ing the ~7MB bundle plus tree-sitter wasm
assets and a static ripgrep. None of that depends on the trial — only on the
task image and the bundle build. Prewarming does it once per (task, bundle)
pair; subsequent trials start with everything already in the image and setup
drops to near-zero (the adapter's probes short-circuit in <1s).

## How to use

```bash
cd bench/swe-bench

# One-shot: bake images for the tasks in this run, then run them prewarmed.
OXAGEN_PREWARMED=1 TASK_IDS="django__django-11099" N_CONCURRENT=1 ./run.sh

# Or pre-bake explicitly (e.g. the full task list, ahead of a big run):
uv run python prewarm.py django__django-11099 sympy__sympy-13031 ...
uv run python prewarm.py --dry-run django__django-11099   # show what would build
```

`run.sh` with `OXAGEN_PREWARMED=1` (and `AGENT=oxagen`) does three things:

1. exports `OXAGEN_BUNDLE_SHA256` (sha256 of the resolved CLI bundle);
2. best-effort runs `prewarm.py` for the resolved `TASK_IDS`;
3. passes `--env oxagen_swe_bench.prewarm_env:PrewarmedDockerEnvironment`
   to `harbor run`.

`prewarm.py` requires the Harbor task package to already be cached under
`~/.cache/harbor/tasks/packages/swe-bench/<instance>/` — run the bench once
for a task (or let step 2 above no-op with a clear message) before baking it.

## What gets built

Two local images per task, both content-addressed:

| Image | Contents |
|---|---|
| `oxagen-taskbase/<name>:<envhash12>` | The task's own `environment/Dockerfile` built as-is (preserves any task-added `RUN` steps on top of the `swebench/sweb.eval.*` instance image). |
| `oxagen-prewarmed/<name>:<envhash12>-<bundlesha12>` | The overlay (`prewarm/Dockerfile`) on the taskbase: Node 22 (NodeSource), the oxagen bundle + `*.wasm` in `/usr/local/lib/oxagen/`, the `/usr/local/bin/oxagen` wrapper (byte-identical to the adapter's runtime wrapper), static `rg`, and `/usr/local/lib/oxagen/.bundle.sha256`. |

- `<name>` — sanitized from the first `FROM` of the task's
  `environment/Dockerfile` (e.g. `sweb.eval.x86_64.django_1776_django-11099`).
- `<envhash12>` — first 12 hex chars of Harbor's `environment_content_hash`
  over the `environment/` dir (the same value as `environment_id` at trial
  time). **Invalidated by any change to the task's environment definition.**
- `<bundlesha12>` — first 12 hex chars of the bundle's sha256.
  **Invalidated by every bundle rebuild.** Stale prewarmed images simply stop
  matching; prune them with `docker image prune` / `docker rmi` at leisure.

## How the trial picks it up

`PrewarmedDockerEnvironment` (`src/oxagen_swe_bench/prewarm_env.py`) overrides
Harbor's `_maybe_override_task_env_config()`: when `OXAGEN_PREWARMED` is
truthy and `docker image inspect` finds the expected tag, it sets
`task_env_config.docker_image`, which makes Harbor's
`should_use_prebuilt_docker_image()` skip the image build and run the tag
directly. If `OXAGEN_BUNDLE_SHA256` is unset it only accepts a tag when
exactly one local tag matches the `<envhash12>-` prefix (ambiguity → normal
build).

Independently, the adapter (`oxagen_agent.py`) fast-paths its `install()`:
it compares `/usr/local/lib/oxagen/.bundle.sha256` in the container against
the local bundle and skips the bundle/wasm upload on a match, and probes
`command -v <tool>` for each of `rg` / `fd` / `fzf` before uploading that
static binary. The Node install script already fast-exits when Node ≥ 20 is
present.

## Fallback guarantees

Prewarming is an optimization, never a dependency:

- missing/stale prewarmed image → Harbor builds the task image normally;
- `prewarm.py` build failure (e.g. base image without `apt-get` — the overlay
  fails loudly by design) → recorded as `skipped` in its summary; the run
  proceeds;
- any exception in `PrewarmedDockerEnvironment` → one-line warning, normal
  build;
- any probe failure in the adapter fast-paths → original upload path.

A prewarm problem can therefore never fail a trial — worst case is the old
~109s setup cost.
