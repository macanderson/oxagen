#!/usr/bin/env python3
"""
Emit a normalized oxagen.eval.v1 JSON from a Harbor SWE-bench run directory.

After each `harbor run` (or `./run.sh` / `./compare.sh`) completes, call this
script to convert the per-trial result.json files into the ingester-ready
schema:

    python bench/swe-bench/emit_eval_json.py [run-dir]
    # e.g.
    python bench/swe-bench/emit_eval_json.py results-oxagen/2026-06-27__18-54-46

The JSON is written to <run-dir>/swe-bench.eval.json, AND a copy is written to
bench/swe-bench/results/<agent>-<run_id>.eval.json so compare.sh and the
dashboard can find every agent's results in one shared directory regardless
of which results-<agent>/ jobs dir they came from.

Then ingest to ClickHouse with:
    pnpm eval:ingest bench/swe-bench/results/*.eval.json

If no run-dir is supplied the script picks the newest subdirectory it can find
across all results-* jobs dirs (results-oxagen/, results-claude-code/,
results-codex/, results-aider/, and any other results-* directory next to
this script) or under the JOBS_DIR environment variable.

Environment:
    JOBS_DIR   Jobs directory to scan for the newest run (path, relative to this
               script or absolute). Overrides the auto-detect heuristic.

The actual Harbor-run normalization (reading config.json/result.json, deriving
agent/model/suite, aggregating metrics) lives in
oxagen_terminal_bench.eval_normalize.build_eval_json — this file is just the
CLI entry point for the swe-bench harness. See
bench/terminal-bench/emit_eval_json.py for the sibling Terminal-Bench entry
point, which shares the same normalizer.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "terminal-bench" / "src"))

from oxagen_terminal_bench.eval_normalize import build_eval_json  # noqa: E402

HARNESS = "swe-bench"

# Jobs directories to scan when no run-dir arg is given (relative to this script).
_DEFAULT_JOBS_DIRS = ["results-oxagen", "results-claude-code", "results-codex", "results-aider"]


# ---------------------------------------------------------------------------
# Run-directory discovery
# ---------------------------------------------------------------------------

def _candidate_jobs_dirs() -> list[Path]:
    jobs_dir_env = os.environ.get("JOBS_DIR")
    if jobs_dir_env:
        return [Path(jobs_dir_env)]

    dirs = {HERE / d for d in _DEFAULT_JOBS_DIRS}
    # Any other results-* dir (e.g. results-gemini-cli, results-swe-agent,
    # results-openhands) added by a compare.sh run with a custom COMPETITORS list.
    dirs.update(p for p in HERE.glob("results-*") if p.is_dir())
    return sorted(dirs)


def _find_newest_run_dir() -> Path:
    """Return the newest run directory across known jobs dirs."""
    candidates: list[Path] = []
    for jobs_dir in _candidate_jobs_dirs():
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

    payload = build_eval_json(run_dir, harness=HARNESS)
    run = payload["run"]
    print(
        f"  agent={run['agent_name']}  model={run['model']}"
        f"  suite={run['suite']}  n={run['n_tasks']}"
        f"  passed={run['n_passed']}  resolved_rate={run['resolved_rate']}"
    )

    out_path = run_dir / "swe-bench.eval.json"
    out_path.write_text(json.dumps(payload, indent=2))
    print(f"Wrote {out_path}", flush=True)

    # Also copy into the shared results/ dir so compare.sh and the dashboard
    # can find every agent's normalized output in one place.
    shared_dir = HERE / "results"
    shared_dir.mkdir(parents=True, exist_ok=True)
    shared_path = shared_dir / f"{run['agent_name']}-{run['run_id']}.eval.json"
    shared_path.write_text(json.dumps(payload, indent=2))
    print(f"Copied to {shared_path}", flush=True)

    print(f"\nIngest with:\n    pnpm eval:ingest {out_path}", flush=True)


if __name__ == "__main__":
    main()
