#!/usr/bin/env python3
"""
Emit a normalized oxagen.eval.v1 JSON from a Harbor terminal-bench run directory.

After each `harbor run` (or `./run.sh`) completes, call this script to convert
the per-trial result.json files into the ingester-ready schema:

    python bench/terminal-bench/emit_eval_json.py [run-dir]
    # e.g.
    python bench/terminal-bench/emit_eval_json.py results-oxagen/2026-06-27__18-54-46

The JSON is written to <run-dir>/terminal-bench.eval.json.
Then ingest to ClickHouse with:
    pnpm eval:ingest bench/terminal-bench/<run-dir>/terminal-bench.eval.json

If no run-dir is supplied the script picks the newest subdirectory it can find
under known jobs dirs (results-oxagen/, results-claude/, oxagen-tbench-results/)
or under the JOBS_DIR environment variable.

Environment:
    JOBS_DIR   Jobs directory to scan for the newest run (path, relative to this
               script or absolute). Overrides the auto-detect heuristic.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
HARNESS = "terminal-bench"

# Jobs directories to scan when no run-dir arg is given (relative to this script).
_DEFAULT_JOBS_DIRS = ["results-oxagen", "results-claude", "oxagen-tbench-results"]


# ---------------------------------------------------------------------------
# Run-directory discovery
# ---------------------------------------------------------------------------

def _find_newest_run_dir() -> Path:
    """Return the newest run directory across known jobs dirs."""
    jobs_dir_env = os.environ.get("JOBS_DIR")
    if jobs_dir_env:
        search_dirs = [Path(jobs_dir_env)]
    else:
        search_dirs = [HERE / d for d in _DEFAULT_JOBS_DIRS]

    candidates: list[Path] = []
    for jobs_dir in search_dirs:
        if not jobs_dir.is_dir():
            continue
        for entry in jobs_dir.iterdir():
            if entry.is_dir() and (entry / "result.json").exists():
                candidates.append(entry)

    if not candidates:
        raise SystemExit(
            "No completed run directories found.\n"
            "Pass a run directory explicitly:\n"
            "    python emit_eval_json.py results-oxagen/2026-06-27__18-54-46"
        )
    # Sort by directory name (ISO-timestamp names sort lexicographically = chronologically).
    return max(candidates, key=lambda d: d.name)


# ---------------------------------------------------------------------------
# Data readers
# ---------------------------------------------------------------------------

def _read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def _collect_trial_dirs(run_dir: Path) -> list[Path]:
    """Return all subdirectories that contain a result.json (= trial dirs)."""
    return sorted(
        [d for d in run_dir.iterdir() if d.is_dir() and (d / "result.json").exists()],
        key=lambda d: d.name,
    )


# ---------------------------------------------------------------------------
# Agent / model metadata helpers
# ---------------------------------------------------------------------------

def _agent_name_from_config(config: dict) -> str:
    """
    Derive a short agent name from the Harbor config.

    Handles both built-in agent names ("claude-code") and external import paths
    ("oxagen_terminal_bench:OxagenAgent" -> "oxagen").
    """
    agents = config.get("agents", [])
    if not agents:
        return "unknown"
    name = agents[0].get("name", "")
    if ":" in name:
        # module:ClassName form — strip "Agent" suffix and lower-snake it.
        cls = name.split(":")[-1]
        if cls.endswith("Agent"):
            cls = cls[:-5]
        return cls.lower().replace("_", "-")
    return name or "unknown"


def _agent_name_from_trial(trial: dict) -> str:
    info = trial.get("agent_info") or {}
    return info.get("name", "")


def _model_from_config(config: dict) -> str:
    agents = config.get("agents", [])
    if not agents:
        return ""
    return agents[0].get("model_name", "")


def _model_from_trial(trial: dict) -> str:
    info = (trial.get("agent_info") or {}).get("model_info") or {}
    provider = info.get("provider", "")
    name = info.get("name", "")
    if provider and name:
        return f"{provider}/{name}"
    return name or ""


def _suite_from_config(config: dict) -> str:
    datasets = config.get("datasets", [])
    if not datasets:
        return "terminal-bench"
    ds = datasets[0]
    name = ds.get("name", "terminal-bench")
    version = ds.get("version", "")
    return f"{name}-{version}" if version else name


# ---------------------------------------------------------------------------
# Wall-time helper
# ---------------------------------------------------------------------------

def _parse_utc(s: str | None) -> datetime | None:
    if not s:
        return None
    s = s.rstrip("Z").replace("+00:00", "")
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def _wall_from_trial(trial: dict) -> float | None:
    """
    Prefer oxagen_wall_sec from metadata (already parsed by the adapter).
    Fall back to agent_execution start/finished timestamps.
    """
    ar = trial.get("agent_result") or {}
    meta = ar.get("metadata") or {}
    if "oxagen_wall_sec" in meta and meta["oxagen_wall_sec"] is not None:
        return float(meta["oxagen_wall_sec"])
    ae = trial.get("agent_execution") or {}
    t0 = _parse_utc(ae.get("started_at"))
    t1 = _parse_utc(ae.get("finished_at"))
    if t0 and t1:
        return round((t1 - t0).total_seconds(), 1)
    return None


# ---------------------------------------------------------------------------
# Graph-flag inference
# ---------------------------------------------------------------------------

def _graph_flags(agent_name: str) -> tuple[int, int, int]:
    """Return (graph_code, graph_exec, graph_mem) based on the agent."""
    if "oxagen" in agent_name.lower():
        return 1, 1, 1
    return 0, 0, 0


# ---------------------------------------------------------------------------
# JSON assembly
# ---------------------------------------------------------------------------

def _build_trial_result(trial: dict) -> dict:
    task_name = trial.get("task_name", "")
    trial_name = trial.get("trial_name", task_name)
    vr = (trial.get("verifier_result") or {}).get("rewards") or {}
    reward_raw = vr.get("reward", 0.0)
    try:
        reward = float(reward_raw)
    except (TypeError, ValueError):
        reward = 0.0
    passed = 1 if reward >= 1.0 else 0

    ar = trial.get("agent_result") or {}
    meta = ar.get("metadata") or {}

    metrics: dict[str, float] = {}
    if ar.get("cost_usd") is not None:
        try:
            metrics["cost_usd"] = float(ar["cost_usd"])
        except (TypeError, ValueError):
            pass

    # Token totals — oxagen uses metadata; claude-code uses top-level fields.
    oxagen_tok = meta.get("oxagen_total_tokens")
    if oxagen_tok is not None:
        try:
            metrics["tokens"] = float(oxagen_tok)
        except (TypeError, ValueError):
            pass
    else:
        n_in = ar.get("n_input_tokens") or 0
        n_cache = ar.get("n_cache_tokens") or 0
        n_out = ar.get("n_output_tokens") or 0
        total = n_in + n_cache + n_out
        if total:
            metrics["tokens"] = float(total)

    wall = _wall_from_trial(trial)
    if wall is not None:
        metrics["wall_s"] = wall

    labels: dict[str, str] = {"trial_name": trial_name}
    exc = trial.get("exception_info")
    if exc:
        exc_type = exc.get("exception_type") if isinstance(exc, dict) else str(exc)
        if exc_type:
            labels["exception"] = str(exc_type)

    return {
        "task_id": task_name,
        "passed": passed,
        "reward": round(reward, 6),
        "metrics": metrics,
        "labels": labels,
        "task_group": "",
        "repeat_idx": 0,
    }


def build_eval_json(run_dir: Path) -> dict:
    config = _read_json(run_dir / "config.json")
    job_result = _read_json(run_dir / "result.json")

    trial_dirs = _collect_trial_dirs(run_dir)

    # Read trial results — tolerate missing files gracefully.
    trial_results: list[dict] = []
    for td in trial_dirs:
        try:
            trial_results.append(_read_json(td / "result.json"))
        except Exception as exc:
            print(f"  [warn] could not read {td / 'result.json'}: {exc}", flush=True)

    # Prefer agent name / model from actual trial data (most accurate).
    first_trial = trial_results[0] if trial_results else {}
    agent_name = _agent_name_from_trial(first_trial) or _agent_name_from_config(config)
    model = _model_from_trial(first_trial) or _model_from_config(config)
    agent_version = (first_trial.get("agent_info") or {}).get("version", "")

    suite = _suite_from_config(config)
    job_id = job_result.get("id", "")
    run_id = f"{HARNESS}-{job_id}" if job_id else f"{HARNESS}-{run_dir.name}-{int(time.time())}"

    results = [_build_trial_result(t) for t in trial_results]
    n_tasks = len(results)
    n_passed = sum(r["passed"] for r in results)
    resolved_rate = round(n_passed / n_tasks, 4) if n_tasks else 0.0

    # Aggregate run-level metrics.
    cost_total = sum(r["metrics"].get("cost_usd", 0.0) for r in results)
    tok_total = sum(r["metrics"].get("tokens", 0.0) for r in results)
    wall_total = sum(r["metrics"].get("wall_s", 0.0) for r in results)

    run_metrics: dict[str, float] = {}
    if cost_total:
        run_metrics["cost_usd"] = round(cost_total, 6)
    if tok_total:
        run_metrics["tokens"] = tok_total
    if wall_total:
        run_metrics["wall_s"] = round(wall_total, 1)

    # Pull top-level job cost/token summary from the job result if available
    # (claude-code populates these; oxagen does not).
    job_stats = job_result.get("stats") or {}
    if job_stats.get("cost_usd") is not None and "cost_usd" not in run_metrics:
        try:
            run_metrics["cost_usd"] = round(float(job_stats["cost_usd"]), 6)
        except (TypeError, ValueError):
            pass

    graph_code, graph_exec, graph_mem = _graph_flags(agent_name)

    return {
        "schema": "oxagen.eval.v1",
        "run": {
            "run_id": run_id,
            "run_group": "",
            "agent_name": agent_name,
            "agent_version": agent_version,
            "model": model,
            "harness": HARNESS,
            "suite": suite,
            "suite_version": "",
            "git_sha": "",
            "git_branch": "",
            "environment": "local",
            "graph_code": graph_code,
            "graph_exec": graph_exec,
            "graph_mem": graph_mem,
            "warm": 0,
            "history_depth": 0,
            "seed": 0,
            "n_tasks": n_tasks,
            "n_passed": n_passed,
            "resolved_rate": resolved_rate,
            "metrics": run_metrics,
            "labels": {"jobs_dir": config.get("jobs_dir", "")},
            "notes": "",
        },
        "results": results,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    if len(sys.argv) >= 2:
        run_dir = Path(sys.argv[1])
        # Resolve relative to the script's directory for convenience.
        if not run_dir.is_absolute():
            run_dir = HERE / run_dir
    else:
        print("No run-dir supplied — scanning for newest run…", flush=True)
        run_dir = _find_newest_run_dir()

    if not run_dir.is_dir():
        raise SystemExit(f"Run directory not found: {run_dir}")
    if not (run_dir / "result.json").exists():
        raise SystemExit(f"Not a valid run directory (no result.json): {run_dir}")

    print(f"Processing run: {run_dir}", flush=True)

    payload = build_eval_json(run_dir)
    run = payload["run"]
    print(
        f"  agent={run['agent_name']}  model={run['model']}"
        f"  suite={run['suite']}  n={run['n_tasks']}"
        f"  passed={run['n_passed']}  resolved_rate={run['resolved_rate']}"
    )

    out_path = run_dir / "terminal-bench.eval.json"
    out_path.write_text(json.dumps(payload, indent=2))
    print(f"Wrote {out_path}", flush=True)
    print(f"\nIngest with:\n    pnpm eval:ingest {out_path}", flush=True)


if __name__ == "__main__":
    main()
