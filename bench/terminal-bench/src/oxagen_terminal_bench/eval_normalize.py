"""
Shared Harbor-run → ``oxagen.eval.v1`` normalization.

Both ``bench/terminal-bench/emit_eval_json.py`` and ``bench/swe-bench/emit_eval_json.py``
are thin CLI wrappers around :func:`build_eval_json` here — the actual result
parsing (reading Harbor's ``config.json`` / per-trial ``result.json`` files,
deriving agent/model/suite metadata, aggregating cost/token/wall-time metrics)
lives in exactly one place so the two harnesses can never drift apart.

The harness name (``"terminal-bench"`` vs ``"swe-bench"``) is the only thing
that differs between callers, so it is the sole required parameter.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path

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


def _suite_from_config(config: dict, harness: str) -> str:
    datasets = config.get("datasets", [])
    if not datasets:
        return harness
    ds = datasets[0]
    name = ds.get("name", harness)
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


def build_eval_json(run_dir: Path, harness: str = "terminal-bench") -> dict:
    """Normalize a Harbor run directory into the ``oxagen.eval.v1`` schema.

    ``harness`` is stamped onto ``run.harness`` and used as the suite-name
    fallback and the ``run_id`` prefix — it is the only axis on which
    terminal-bench and swe-bench differ; everything else (reading
    ``config.json`` / per-trial ``result.json``, agent/model derivation, cost
    and token aggregation) is identical across both callers.
    """
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

    suite = _suite_from_config(config, harness)
    job_id = job_result.get("id", "")
    run_id = f"{harness}-{job_id}" if job_id else f"{harness}-{run_dir.name}-{int(time.time())}"

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
            "harness": harness,
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
