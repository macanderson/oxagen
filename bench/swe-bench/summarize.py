#!/usr/bin/env python3
"""Summarize the newest Harbor run in each given jobs-dir: per-task pass/fail,
agent wall seconds, tokens, cost — and an agent-vs-agent table."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def parse_utc(s: str | None):
    if not s:
        return None
    s = s.rstrip("Z").replace("+00:00", "")
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def newest_run(jobs_dir: Path) -> Path | None:
    runs = sorted(
        d for d in jobs_dir.iterdir()
        if d.is_dir() and (d / "result.json").exists()
    )
    return runs[-1] if runs else None


def trial_rows(run_dir: Path):
    rows = []
    for td in sorted(run_dir.iterdir()):
        rj = td / "result.json"
        if not td.is_dir() or not rj.exists():
            continue
        t = json.loads(rj.read_text())
        vr = (t.get("verifier_result") or {}).get("rewards") or {}
        reward = float(vr.get("reward") or 0.0)
        ar = t.get("agent_result") or {}
        meta = ar.get("metadata") or {}
        ae = t.get("agent_execution") or {}
        t0, t1 = parse_utc(ae.get("started_at")), parse_utc(ae.get("finished_at"))
        wall = (t1 - t0).total_seconds() if t0 and t1 else None
        tokens = meta.get("oxagen_total_tokens")
        if tokens is None:
            tokens = (ar.get("n_input_tokens") or 0) + (ar.get("n_cache_tokens") or 0) + (ar.get("n_output_tokens") or 0)
        exc = t.get("exception_info")
        rows.append({
            "task": t.get("task_name", td.name),
            "passed": reward >= 1.0,
            "wall_s": round(wall, 1) if wall is not None else None,
            "tokens": tokens or None,
            "cost": ar.get("cost_usd"),
            "exception": (exc.get("exception_type") if isinstance(exc, dict) else str(exc)) if exc else None,
        })
    return rows


def main(dirs: list[str]) -> None:
    agents = {}
    for d in dirs:
        p = Path(d)
        if not p.is_dir():
            continue
        run = newest_run(p)
        if run is None:
            continue
        rows = trial_rows(run)
        agents[p.name.replace("results-", "")] = (run, rows)

    for agent, (run, rows) in agents.items():
        n = len(rows)
        npass = sum(r["passed"] for r in rows)
        walls = [r["wall_s"] for r in rows if r["wall_s"] is not None]
        print(f"\n== {agent}  ({run.name})  resolved {npass}/{n}"
              f"  total-wall {round(sum(walls), 1) if walls else '?'}s"
              f"  median-wall {round(sorted(walls)[len(walls)//2], 1) if walls else '?'}s")
        for r in sorted(rows, key=lambda r: r["task"]):
            mark = "PASS" if r["passed"] else "fail"
            exc = f"  EXC={r['exception']}" if r["exception"] else ""
            wall = f"{r['wall_s']}s" if r["wall_s"] is not None else "?"
            tok = f"{int(r['tokens']):,}" if r["tokens"] else "?"
            print(f"  {mark}  {r['task']:<45} {wall:>8}  {tok:>10} tok{exc}")

    if len(agents) == 2:
        (a_name, (_, a_rows)), (b_name, (_, b_rows)) = agents.items()
        a = {r["task"]: r for r in a_rows}
        b = {r["task"]: r for r in b_rows}
        common = sorted(set(a) & set(b))
        print(f"\n== head-to-head ({a_name} vs {b_name}) on {len(common)} common tasks")
        for task in common:
            ra, rb = a[task], b[task]
            pa = "PASS" if ra["passed"] else "fail"
            pb = "PASS" if rb["passed"] else "fail"
            wa = ra["wall_s"] or float("inf")
            wb = rb["wall_s"] or float("inf")
            faster = a_name if wa < wb else b_name
            print(f"  {task:<45} {pa}/{pb}  {ra['wall_s']}s vs {rb['wall_s']}s  faster={faster}")


if __name__ == "__main__":
    main(sys.argv[1:] or ["./results-oxagen", "./results-claude-code"])
