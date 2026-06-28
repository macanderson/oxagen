#!/usr/bin/env python3
"""
Context-on eval — does oxagen's context engine (local code-graph + project rules +
prompt-enhancer) answer repo-grounded questions more accurately / cheaply than a
cold same-model agent (Claude Code)?

This is the eval Terminal-Bench structurally can't run: cold-start, unknown-repo
benchmarks turn oxagen's context engine OFF. Here every arm works on THIS repo,
where knowing the codebase is the whole point.

Four arms, all read-only, same model (Sonnet 4.5), same repo:
  - oxagen-full : oxagen --readonly  (cold: fresh HOME each question; full pipeline)
  - oxagen-lean : oxagen --readonly --no-pipeline  (cold: fresh HOME; code_graph only)
  - oxagen-warm : oxagen --readonly  (warm: HOME persists across questions AND rounds)
  - claude      : claude -p          (cold scaffold: Read/Grep/Glob)

Cold arms use a fresh empty tmpdir as HOME for every question so no prior state
bleeds across questions.  The warm arm uses one shared tmpdir for the entire run
(across all questions and all rounds), so lessons/traces from question N are
readable by question N+1.

Metrics per arm: accuracy (deterministic substring grading), total cost $, tokens, wall.
For oxagen-warm with --rounds N: per-round metrics are reported so a learning curve
(round 1 → round N) is visible.  Use --wipe-reversion to verify that deleting the
persistent memory dir causes performance to revert — the causal test from
eval-runbook §7.3.

Prereqs: built oxagen bundle (`pnpm --filter @oxagen/cli bundle`), `claude` CLI on
PATH, and AI_GATEWAY_API_KEY (env or repo .env.local).

Usage:
    python bench/context-eval/run_eval.py
    OXAGEN_ARMS=oxagen-lean,claude python bench/context-eval/run_eval.py   # subset
    python bench/context-eval/run_eval.py --rounds 3                        # warm 3×
    python bench/context-eval/run_eval.py --rounds 3 --wipe-reversion       # + causal test
    EVAL_ROUNDS=3 python bench/context-eval/run_eval.py --wipe-reversion    # env-var form
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
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


def oxagen(task: dict, lean: bool, home_dir: Path | None = None) -> dict:
    """Run oxagen against a single task.

    home_dir overrides HOME so the CLI reads/writes its config and memory under
    <home_dir>/.config/oxagen/ rather than the developer's real ~/.config/oxagen/.

    Cold arms call this with a fresh empty tmpdir per question (no state bleeds).
    The warm arm calls it with a shared persistent dir across all questions and
    rounds (state accumulates, enabling self-improvement).

    The HOME env-var override works because all CLI path helpers (trace-store,
    fleet/memory, verbose-log, settings, agents, commands) call node:os.homedir(),
    which reads HOME on Linux/macOS.  Confirmed in:
      apps/cli/src/agent/trace-store.ts   (homedir() → ~/.config/oxagen/traces/)
      apps/cli/src/agent/fleet/memory.ts  (homedir() → ~/.config/oxagen/memories/)
      apps/cli/src/agent/memory.ts        (homedir() → ~/.config/oxagen/context.duckdb)
      apps/cli/src/settings/resolve.ts    (homedir() → ~/.config/oxagen/settings.json)
    and verified in the existing unit tests
    (apps/cli/src/agent/__tests__/fleet-memory.test.ts: sets process.env["HOME"]).
    """
    env = {**os.environ, "AI_GATEWAY_API_KEY": gw_key()}
    if home_dir is not None:
        env["HOME"] = str(home_dir)
    cmd = ["node", BUNDLE, task["q"], "--readonly", "--model", OX_MODEL, "--verbose"]
    if lean:
        cmd.append("--no-pipeline")
    rc, out, err, wall = run(cmd, env=env)
    m = EFF.search(err) or EFF.search(out)
    return {"answer": out.strip(), "correct": grade(out, task["require"]),
            "cost": float(m.group(3)) if m else None,
            "tokens": int(m.group(2).replace(",", "")) if m else None,
            "wall": round(wall, 1), "rc": rc}


def _cold_call(task: dict, lean: bool) -> dict:
    """Run oxagen cold: a fresh empty HOME per question so no prior state accumulates."""
    with tempfile.TemporaryDirectory(prefix="oxa-cold-") as tmp:
        return oxagen(task, lean=lean, home_dir=Path(tmp))


def claude(task: dict) -> dict:
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


# Base arms (all cold: fresh HOME per question).  The warm arm is injected in main().
ARMS: dict[str, object] = {
    "oxagen-full": lambda t: _cold_call(t, lean=False),
    "oxagen-lean": lambda t: _cold_call(t, lean=True),
    "claude": claude,
}


def _run_round(arm_names: list[str], arm_fns: dict) -> dict:
    """Run every arm against all tasks; return {arm: {task_id: result}}."""
    results: dict[str, dict] = {}
    for task in TASKS:
        print(f"\n### {task['id']}", flush=True)
        for arm in arm_names:
            r = arm_fns[arm](task)
            results.setdefault(arm, {})[task["id"]] = r
            print(
                f"  {arm:16} correct={r['correct']} cost={r['cost']} "
                f"tok={r['tokens']} {r['wall']}s rc={r['rc']}",
                flush=True,
            )
    return results


def _summarize(results: dict[str, dict]) -> None:
    """Print a summary table for one set of arm results."""
    print(f"\n{'arm':20}{'pass':>8}{'cost$':>10}{'tokens':>12}{'wall_s':>9}")
    for arm, rs in results.items():
        n = len(rs)
        passed = sum(1 for r in rs.values() if r["correct"])
        cost = sum(r["cost"] or 0 for r in rs.values())
        toks = sum(r["tokens"] or 0 for r in rs.values())
        wall = sum(r["wall"] or 0 for r in rs.values())
        print(f"{arm:20}{f'{passed}/{n}':>8}{cost:>10.4f}{toks:>12,}{wall:>9.0f}")


def _print_learning_curve(warm_round_results: dict) -> None:
    """Print a compact per-round table for the warm arm."""
    print("\n----- WARM LEARNING CURVE -----")
    print(f"{'round/phase':24}{'pass':>8}{'cost$':>10}{'tokens':>12}")
    for key, rs in warm_round_results.items():
        n = len(rs)
        passed = sum(1 for r in rs.values() if r["correct"])
        cost = sum(r["cost"] or 0 for r in rs.values())
        toks = sum(r["tokens"] or 0 for r in rs.values())
        print(f"{key:24}{f'{passed}/{n}':>8}{cost:>10.4f}{toks:>12,}")
    print()
    print("Interpretation:")
    print("  Rising pass rate round_1 → round_N = positive learning slope (H4 monotonic clause).")
    print("  wipe_reversion near round_1 rate   = graphs drove the improvement (H4 causal clause).")
    print("  Flat or noise-only curve           = thesis not supported on this question set.")


def _is_truthy(v: str | None) -> bool:
    return (v or "").strip().lower() in {"1", "true", "yes", "on"}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Context-on eval: oxagen warm/cold vs Claude Code.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--rounds", type=int,
        default=int(os.environ.get("EVAL_ROUNDS", "1")),
        metavar="N",
        help=(
            "Number of times to run the full question set for the oxagen-warm arm, "
            "persisting memory across rounds to measure the learning curve "
            "(default: 1; env: EVAL_ROUNDS)."
        ),
    )
    parser.add_argument(
        "--wipe-reversion", action="store_true",
        help=(
            "After all warm rounds, wipe the persistent memory dir and re-run once "
            "to confirm performance reverts to cold-start baseline — the causal test "
            "from eval-runbook §7.3 (H4 causal clause)."
        ),
    )
    args = parser.parse_args()
    n_rounds = max(1, args.rounds)
    do_wipe = args.wipe_reversion

    selected = os.environ.get("OXAGEN_ARMS")
    arm_names = selected.split(",") if selected else list(ARMS) + ["oxagen-warm"]

    # Create a single persistent HOME dir for the warm arm (lives for the whole run).
    warm_home: Path | None = None
    arm_fns: dict = dict(ARMS)
    if "oxagen-warm" in arm_names:
        warm_home = Path(tempfile.mkdtemp(prefix="oxa-warm-"))
        # Capture warm_home in the default-arg so the lambda stays bound to the
        # current value even if warm_home is reassigned (it isn't, but be explicit).
        arm_fns["oxagen-warm"] = lambda t, _h=warm_home: oxagen(t, lean=False, home_dir=_h)
        print(
            f"==> Warm memory dir: {warm_home}\n"
            f"    (persists across all {len(TASKS)} questions × {n_rounds} round(s))"
        )

    try:
        all_results: dict = {}

        # --- Cold arms (run once as baseline) ---
        cold_arms = [a for a in arm_names if a != "oxagen-warm"]
        if cold_arms:
            print("\n===== COLD ARMS (baseline) =====")
            cold_results = _run_round(cold_arms, arm_fns)
            for arm, rs in cold_results.items():
                all_results[arm] = rs
            print("\n===== COLD SUMMARY =====")
            _summarize(cold_results)

        # --- Warm arm (N rounds, accumulating memory) ---
        if "oxagen-warm" in arm_names:
            warm_round_results: dict[str, dict] = {}

            for rnd in range(1, n_rounds + 1):
                print(f"\n===== WARM ROUND {rnd}/{n_rounds} =====")
                rnd_data = _run_round(["oxagen-warm"], arm_fns)
                warm_round_results[f"round_{rnd}"] = rnd_data["oxagen-warm"]
                print(f"\n===== WARM ROUND {rnd} SUMMARY =====")
                _summarize(rnd_data)

            # --- Wipe-reversion test (§7.3) ---
            if do_wipe and warm_home is not None:
                print(f"\n===== WIPE-REVERSION =====")
                print(f"Wiping {warm_home} …")
                shutil.rmtree(warm_home)
                warm_home.mkdir(parents=True, exist_ok=True)
                print("Memory wiped. Re-running to confirm reversion to cold-start…")
                wiped_data = _run_round(["oxagen-warm"], arm_fns)
                warm_round_results["wipe_reversion"] = wiped_data["oxagen-warm"]
                print("\n===== WIPE-REVERSION SUMMARY =====")
                _summarize(wiped_data)

            all_results["oxagen-warm"] = warm_round_results

            if n_rounds > 1 or do_wipe:
                _print_learning_curve(warm_round_results)

        OUT.write_text(json.dumps(all_results, indent=2))
        print(f"\nResults written to {OUT}")

        # Final flat summary: last warm round + all cold arms side-by-side.
        print("\n\n===== FINAL SUMMARY =====")
        flat: dict[str, dict] = {}
        for arm, data in all_results.items():
            if arm == "oxagen-warm":
                last_key = f"round_{n_rounds}"
                if last_key in data:
                    flat[f"oxagen-warm (r{n_rounds})"] = data[last_key]
            else:
                flat[arm] = data
        _summarize(flat)

        if n_rounds > 1:
            print(
                "\nNOTE: warm-vs-cold and round_1-vs-round_N pass/cost/token deltas are "
                "the self-improvement signal (H4).  See eval-runbook §7 for statistical "
                "interpretation."
            )

    finally:
        # Remove the warm home dir unless the caller wants to keep it.
        if warm_home and not _is_truthy(os.environ.get("OXAGEN_KEEP_WARM_HOME")):
            shutil.rmtree(warm_home, ignore_errors=True)


if __name__ == "__main__":
    main()
