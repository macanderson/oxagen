"""
Unit test for the shared Harbor-run normalizer, exercised via the swe-bench
harness name.

Builds a synthetic Harbor run directory (config.json + job-level result.json
+ two trial dirs, one passed and one failed) and asserts build_eval_json
produces a well-formed oxagen.eval.v1 payload with correct resolved-rate math.

Run only this file:
    cd bench/swe-bench && uv run pytest tests/test_emit.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# Make the shared normalizer importable without requiring the package to be
# pip-installed first (mirrors the sys.path fallback in emit_eval_json.py).
_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent.parent / "terminal-bench" / "src"))

from oxagen_terminal_bench.eval_normalize import build_eval_json  # noqa: E402


def _write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data))


def _make_run_dir(tmp_path: Path) -> Path:
    run_dir = tmp_path / "2026-06-30__12-00-00"
    run_dir.mkdir()

    _write_json(
        run_dir / "config.json",
        {
            "agents": [
                {
                    "name": "oxagen_swe_bench:OxagenAgent",
                    "model_name": "anthropic/claude-sonnet-4.5",
                }
            ],
            "datasets": [{"name": "swe-bench/swe-bench-verified", "version": ""}],
            "jobs_dir": "results-oxagen",
        },
    )
    _write_json(run_dir / "result.json", {"id": "job-abc123", "stats": {}})

    passed_trial = run_dir / "django__django-11099"
    passed_trial.mkdir()
    _write_json(
        passed_trial / "result.json",
        {
            "task_name": "django__django-11099",
            "trial_name": "django__django-11099-trial0",
            "agent_info": {
                "name": "oxagen",
                "version": "0.1.0",
                "model_info": {"provider": "anthropic", "name": "claude-sonnet-4.5"},
            },
            "verifier_result": {"rewards": {"reward": 1.0}},
            "agent_result": {
                "cost_usd": 0.05,
                "metadata": {"oxagen_total_tokens": 1000, "oxagen_wall_sec": 12.3},
            },
        },
    )

    failed_trial = run_dir / "astropy__astropy-12907"
    failed_trial.mkdir()
    _write_json(
        failed_trial / "result.json",
        {
            "task_name": "astropy__astropy-12907",
            "trial_name": "astropy__astropy-12907-trial0",
            "agent_info": {
                "name": "oxagen",
                "version": "0.1.0",
                "model_info": {"provider": "anthropic", "name": "claude-sonnet-4.5"},
            },
            "verifier_result": {"rewards": {"reward": 0.0}},
            "agent_result": {
                "cost_usd": 0.03,
                "metadata": {"oxagen_total_tokens": 800, "oxagen_wall_sec": 9.1},
            },
        },
    )

    return run_dir


def test_build_eval_json_schema_and_resolved_rate(tmp_path: Path) -> None:
    run_dir = _make_run_dir(tmp_path)

    payload = build_eval_json(run_dir, harness="swe-bench")

    assert payload["schema"] == "oxagen.eval.v1"

    run = payload["run"]
    assert run["harness"] == "swe-bench"
    assert run["suite"] == "swe-bench/swe-bench-verified"
    assert run["agent_name"] == "oxagen"
    assert run["model"] == "anthropic/claude-sonnet-4.5"
    assert run["n_tasks"] == 2
    assert run["n_passed"] == 1
    assert run["resolved_rate"] == 0.5
    assert run["run_id"] == "swe-bench-job-abc123"
    assert run["graph_code"] == 1
    assert run["graph_exec"] == 1
    assert run["graph_mem"] == 1
    # Aggregated run-level cost is the sum of both trials.
    assert run["metrics"]["cost_usd"] == 0.08

    results = payload["results"]
    assert len(results) == 2
    by_task = {r["task_id"]: r for r in results}
    assert by_task["django__django-11099"]["passed"] == 1
    assert by_task["django__django-11099"]["reward"] == 1.0
    assert by_task["astropy__astropy-12907"]["passed"] == 0
    assert by_task["astropy__astropy-12907"]["reward"] == 0.0


def test_build_eval_json_empty_run_has_zero_resolved_rate(tmp_path: Path) -> None:
    run_dir = tmp_path / "empty-run"
    run_dir.mkdir()
    _write_json(run_dir / "config.json", {"agents": [], "datasets": []})
    _write_json(run_dir / "result.json", {"id": "", "stats": {}})

    payload = build_eval_json(run_dir, harness="swe-bench")

    run = payload["run"]
    assert run["n_tasks"] == 0
    assert run["n_passed"] == 0
    assert run["resolved_rate"] == 0.0
    # No job id -> falls back to a run_dir-name + timestamp run_id.
    assert run["run_id"].startswith("swe-bench-empty-run-")
