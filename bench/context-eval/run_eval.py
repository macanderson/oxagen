#!/usr/bin/env python3
"""
Context-on eval — does oxagen's context engine (local code-graph + project rules +
prompt-enhancer) answer repo-grounded questions more accurately / cheaply than a
cold same-model agent (Claude Code)?

This is the eval Terminal-Bench structurally can't run: cold-start, unknown-repo
benchmarks turn oxagen's context engine OFF. Here every arm works on THIS repo,
where knowing the codebase is the whole point.

Three arms, all read-only, same model (Sonnet 4.5), same repo:
  - oxagen-full : oxagen --readonly                (full pipeline: context injection + judge)
  - oxagen-lean : oxagen --readonly --no-pipeline  (code_graph tool only, no judge tax)
  - claude      : claude -p (cold scaffold: Read/Grep/Glob)

Metrics per arm: accuracy (deterministic substring grading), total cost $, tokens, wall.

Prereqs: built oxagen bundle (`pnpm --filter @oxagen/cli bundle`), `claude` CLI on
PATH, and AI_GATEWAY_API_KEY (env or repo .env.local).

Usage:
    python bench/context-eval/run_eval.py
    OXAGEN_ARMS=oxagen-lean,claude python bench/context-eval/run_eval.py   # subset
"""
import json
import os
import re
import subprocess
import time
from pathlib import Path

REPO = Path(os.environ.get("OXAGEN_REPO", Path(__file__).resolve().parents[2]))
BUNDLE = os.environ.get("OXAGEN_CLI_BUNDLE", str(REPO / "apps/cli/dist-standalone/oxagen.mjs"))
OX_MODEL = os.environ.get("OXAGEN_MODEL_SLUG", "anthropic/claude-sonnet-4.5")
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "sonnet")
TIMEOUT = int(os.environ.get("EVAL_TIMEOUT", "300"))
OUT = Path(__file__).resolve().parent / "results.json"


def gw_key() -> str:
    key = os.environ.get("AI_GATEWAY_API_KEY")
    if key:
        return key
    env = REPO / ".env.local"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("AI_GATEWAY_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("AI_GATEWAY_API_KEY not set (env or repo .env.local)")


# Deterministic, repo-structural questions. `require`: every substring must appear
# (case-insensitive) in the answer for it to count correct. Chosen to favor
# structural lookups where a code graph beats blind grepping.
TASKS = [
    {"id": "cli-default-model",
     "q": "What is the exact string value assigned to the DEFAULT_MODEL constant in the file apps/cli/src/agent/model.ts? Answer with just the value.",
     "require": ["anthropic/claude-sonnet-4.5"]},
    {"id": "oneshot-import",
     "q": "In apps/cli/src/repl/one-shot.ts, which function imported from \"../agent/pipeline.js\" is used to run a single turn? Answer with the function name.",
     "require": ["runturn"]},
    {"id": "mutating-tools",
     "q": "Name the three tool names listed in the MUTATING_TOOLS constant in apps/cli/src/agent/permissions.ts.",
     "require": ["write_file", "edit_file", "bash"]},
    {"id": "codegraph-builder",
     "q": "Which module path does apps/cli/src/agent/code-graph.ts import buildCodeGraph from? Give the import specifier/path.",
     "require": ["daemon/code-graph/builder"]},
    {"id": "cli-bin",
     "q": "In apps/cli/package.json, what is the bin command name and the file path it maps to?",
     "require": ["oxagen", "dist/index.js"]},
    {"id": "proxy-file",
     "q": "In apps/app, what is the path of the Next.js request-interception file that replaces middleware.ts?",
     "require": ["proxy.ts"]},
]


def grade(answer: str, require: list[str]) -> bool:
    a = (answer or "").lower()
    return all(s.lower() in a for s in require)


def run(cmd, env=None):
    t = time.time()
    try:
        p = subprocess.run(cmd, cwd=str(REPO), env=env, capture_output=True, text=True, timeout=TIMEOUT)
        return p.returncode, p.stdout, p.stderr, time.time() - t
    except subprocess.TimeoutExpired as e:
        out = e.stdout if isinstance(e.stdout, str) else ""
        return 124, out or "", "TIMEOUT", time.time() - t


EFF = re.compile(r"([\d.]+)s total\D+([\d,]+)\s*tok\D+\$([\d.]+)")


def oxagen(task, lean):
    env = {**os.environ, "AI_GATEWAY_API_KEY": gw_key()}
    cmd = ["node", BUNDLE, task["q"], "--readonly", "--model", OX_MODEL, "--verbose"]
    if lean:
        cmd.append("--no-pipeline")
    rc, out, err, wall = run(cmd, env=env)
    m = EFF.search(err) or EFF.search(out)
    return {"answer": out.strip(), "correct": grade(out, task["require"]),
            "cost": float(m.group(3)) if m else None,
            "tokens": int(m.group(2).replace(",", "")) if m else None,
            "wall": round(wall, 1), "rc": rc}


def claude(task):
    cmd = ["claude", "-p", task["q"], "--output-format", "json", "--model", CLAUDE_MODEL,
           "--allowedTools", "Read", "Grep", "Glob"]
    rc, out, err, wall = run(cmd)
    answer, cost, toks = "", None, None
    try:
        j = json.loads(out)
        answer = j.get("result", "")
        cost = j.get("total_cost_usd")
        u = j.get("usage", {}) or {}
        toks = sum(u.get(k, 0) or 0 for k in
                   ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
    except Exception:
        answer = out
    return {"answer": answer.strip(), "correct": grade(answer, task["require"]),
            "cost": cost, "tokens": toks, "wall": round(wall, 1), "rc": rc}


ARMS = {
    "oxagen-full": lambda t: oxagen(t, False),
    "oxagen-lean": lambda t: oxagen(t, True),
    "claude": claude,
}


def main():
    selected = os.environ.get("OXAGEN_ARMS")
    arms = selected.split(",") if selected else list(ARMS)
    results = {}
    for task in TASKS:
        print(f"\n### {task['id']}", flush=True)
        for arm in arms:
            r = ARMS[arm](task)
            results.setdefault(arm, {})[task["id"]] = r
            print(f"  {arm:12} correct={r['correct']} cost={r['cost']} tok={r['tokens']} {r['wall']}s rc={r['rc']}", flush=True)
    OUT.write_text(json.dumps(results, indent=2))

    print("\n\n===== SUMMARY =====")
    print(f"{'arm':14}{'pass':>8}{'cost$':>10}{'tokens':>12}{'wall_s':>9}")
    for arm, rs in results.items():
        n = len(rs)
        passed = sum(1 for r in rs.values() if r["correct"])
        cost = sum(r["cost"] or 0 for r in rs.values())
        toks = sum(r["tokens"] or 0 for r in rs.values())
        wall = sum(r["wall"] or 0 for r in rs.values())
        print(f"{arm:14}{f'{passed}/{n}':>8}{cost:>10.4f}{toks:>12,}{wall:>9.0f}")


if __name__ == "__main__":
    main()
