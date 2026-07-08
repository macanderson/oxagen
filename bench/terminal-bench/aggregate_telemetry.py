#!/usr/bin/env python3
"""Aggregate a Terminal-Bench run's per-trial artifacts into a single
fine-tuning / analysis dataset.

For every trial under <job-dir> it emits one JSONL record capturing every
signal the harness preserved — the full agent trajectory (ordered tool calls,
stage transitions, model routing, reasoning), the graded outcome, and the
efficiency metrics — so the agent engine can be tuned from real behavior.

Usage:
    python aggregate_telemetry.py <job-dir> [out-prefix]
    # e.g. python aggregate_telemetry.py oxagen-tbench-results/tbench-sonnet5-full

Writes next to the job dir (or at out-prefix):
    <prefix>.trajectories.jsonl   one rich record per task
    <prefix>.summary.json         run-level rollup + failure taxonomy
"""
from __future__ import annotations

import collections
import json
import os
import re
import sys
from pathlib import Path


def _read_json(p: Path):
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def _parse_events(agent_txt: Path) -> list[dict]:
    """The adapter streams a JSONL-ish event log; keep every JSON object line."""
    events = []
    if not agent_txt.exists():
        return events
    for line in agent_txt.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            events.append(json.loads(line))
        except Exception:
            pass
    return events


def _tool_calls_from_text(agent_txt: Path) -> list[dict]:
    """The TUI-rendered stream marks tool calls as `🔧 name(arg…)` — capture the
    ordered sequence even when a call isn't a clean JSON event."""
    calls = []
    if not agent_txt.exists():
        return calls
    for m in re.finditer(r"🔧\s+([a-z_]+)\(([^\n]*?)\)", agent_txt.read_text(errors="replace")):
        calls.append({"tool": m.group(1), "arg_preview": m.group(2)[:200]})
    return calls


def _parse_debug_log(cli_output: Path) -> dict:
    """Parse the OXAGEN_CLI_DEBUG JSONL log (agent/oxagen-debug/cli.output) into
    structured per-LLM-call / per-tool / per-stage telemetry — the signal the
    bypass TUI stream can't carry. Returns {} when the log is absent."""
    if not cli_output.exists():
        return {}
    llm_calls, tool_events, stages, usages = [], [], [], []
    for line in cli_output.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        d = o.get("data") or {}
        ev = o.get("event")
        if ev == "llm.stream.request":
            llm_calls.append({"model": d.get("model"), "transport": d.get("transport"),
                              "messageCount": d.get("messageCount"), "toolNames": d.get("toolNames")})
        elif ev == "turn.tool-call":
            tool_events.append({"name": d.get("name"), "input_preview": str(d.get("input"))[:160]})
        elif ev == "turn.tool-result":
            # align with the most recent call lacking a result
            for te in reversed(tool_events):
                if "ok" not in te:
                    te["ok"] = d.get("ok"); te["durationMs"] = d.get("durationMs"); break
        elif ev == "turn.stage":
            stages.append({"label": d.get("label"), "detail": d.get("detail")})
        elif ev in ("llm.object.response",):
            if d.get("usage"):
                usages.append(d["usage"])
    models = sorted({c["model"] for c in llm_calls if c.get("model")})
    return {
        "debug_present": True,
        "llm_call_count": len(llm_calls),
        "llm_calls": llm_calls,
        "models_used": models,
        "tool_events": tool_events,             # name + ok + durationMs — richer than TUI regex
        "tool_failures": [t for t in tool_events if t.get("ok") is False],
        "stage_timeline": stages,
        "object_usages": usages,
    }


def _reward(result: dict) -> float | None:
    vr = result.get("verifier_result") or {}
    r = vr.get("rewards") or {}
    return r.get("reward", vr.get("reward"))


def build(job_dir: Path):
    trials = sorted(p.parent for p in job_dir.glob("*/result.json"))
    records, summary_rows = [], []
    tool_hist = collections.Counter()
    fail_modes = collections.Counter()

    for t in trials:
        result = _read_json(t / "result.json") or {}
        task = (result.get("task_name") or t.name.rsplit("__", 1)[0])
        reward = _reward(result)
        resolved = reward == 1.0
        ar = result.get("agent_result") or {}
        md = ar.get("metadata") or {}
        events = _parse_events(t / "agent" / "oxagen.txt")
        tool_calls = _tool_calls_from_text(t / "agent" / "oxagen.txt")
        debug = _parse_debug_log(t / "agent" / "oxagen-debug" / "cli.output")
        # Prefer the structured debug-log tool events for the histogram; fall
        # back to the TUI-regex sequence when the debug log is absent.
        if debug.get("tool_events"):
            for te in debug["tool_events"]:
                tool_hist[te.get("name") or "?"] += 1
        else:
            for c in tool_calls:
                tool_hist[c["tool"]] += 1

        # Stage timeline + model routing from structured events.
        stages = [e for e in events if e.get("type") == "stage" or "label" in e and "·" in str(e.get("label", ""))]
        models = sorted({e.get("label") for e in events if isinstance(e.get("label"), str) and e["label"].startswith("model ·")})
        exc = (result.get("exception_info") or {}).get("exception_type")

        # Failure taxonomy for the unresolved.
        fmode = None
        if not resolved:
            if exc:
                fmode = f"harness:{exc}"
            elif reward is None:
                fmode = "ungraded"
            else:
                fmode = "wrong-patch"
            fail_modes[fmode] += 1

        rec = {
            "task": task,
            "resolved": resolved,
            "reward": reward,
            "exception": exc,
            "failure_mode": fmode,
            "cost_usd": ar.get("cost_usd"),
            "tokens_total": md.get("oxagen_total_tokens"),
            "wall_sec": md.get("oxagen_wall_sec"),
            "steps": md.get("oxagen_steps"),
            "models": models,
            "tool_calls": tool_calls,                 # ordered TUI sequence
            "tool_histogram": dict(collections.Counter(c["tool"] for c in tool_calls)),
            "n_events": len(events),
            "stage_labels": [s.get("label") for s in stages][:40],
            # Structured telemetry from the CLI debug log (when harvested):
            "debug_present": debug.get("debug_present", False),
            "llm_call_count": debug.get("llm_call_count"),
            "llm_calls": debug.get("llm_calls"),
            "models_used": debug.get("models_used"),
            "tool_events": debug.get("tool_events"),       # name + ok + durationMs
            "tool_failures": debug.get("tool_failures"),
            "stage_timeline": debug.get("stage_timeline"),
            "object_usages": debug.get("object_usages"),
        }
        records.append(rec)
        summary_rows.append({"task": task, "resolved": resolved, "cost": ar.get("cost_usd"),
                             "steps": md.get("oxagen_steps"), "wall": md.get("oxagen_wall_sec"),
                             "failure_mode": fmode})

    resolved_n = sum(1 for r in records if r["resolved"])
    costs = [r["cost_usd"] for r in records if r["cost_usd"] is not None]
    walls = [r["wall_sec"] for r in records if r["wall_sec"] is not None]
    steps = [r["steps"] for r in records if r["steps"] is not None]
    summary = {
        "job": job_dir.name,
        "n_tasks": len(records),
        "resolved": resolved_n,
        "resolve_rate": round(resolved_n / len(records), 4) if records else None,
        "total_cost_usd": round(sum(costs), 2) if costs else None,
        "mean_cost_usd": round(sum(costs) / len(costs), 4) if costs else None,
        "mean_wall_sec": round(sum(walls) / len(walls), 1) if walls else None,
        "mean_steps": round(sum(steps) / len(steps), 1) if steps else None,
        "tool_histogram": dict(tool_hist.most_common()),
        "failure_taxonomy": dict(fail_modes.most_common()),
        "per_task": sorted(summary_rows, key=lambda r: (r["resolved"], r["task"])),
    }
    return records, summary


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    job_dir = Path(sys.argv[1]).resolve()
    prefix = Path(sys.argv[2]) if len(sys.argv) > 2 else job_dir
    records, summary = build(job_dir)
    traj_path = Path(f"{prefix}.trajectories.jsonl")
    sum_path = Path(f"{prefix}.summary.json")
    with traj_path.open("w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")
    sum_path.write_text(json.dumps(summary, indent=2) + "\n")
    print(f"==> {len(records)} tasks · resolved {summary['resolved']}/{summary['n_tasks']} "
          f"({summary['resolve_rate']}) · ${summary['total_cost_usd']}")
    print(f"==> trajectories: {traj_path}")
    print(f"==> summary:      {sum_path}")
    print(f"==> failure taxonomy: {summary['failure_taxonomy']}")


if __name__ == "__main__":
    main()
