# Context-on eval — oxagen vs Claude Code

Measures the thing the cold benchmarks (Terminal-Bench, SWE-bench, Aider polyglot)
**structurally can't**: oxagen's edge when it has context about the codebase.

Those benchmarks are cold-start, unknown-repo, single-shot — they deliberately
hand every agent a blank slate, which turns oxagen's context engine (local
code-graph + project rules + prompt-enhancer) OFF. This eval instead asks
repo-grounded questions about **this monorepo**, where knowing the codebase is
the whole game, and compares oxagen against a cold same-model agent (Claude Code)
on **accuracy + cost + tokens**.

## Run it

```bash
pnpm --filter @oxagen/cli bundle        # build the standalone oxagen.mjs
export AI_GATEWAY_API_KEY=...            # or rely on repo .env.local
python bench/context-eval/run_eval.py    # needs `claude` CLI on PATH for the baseline
```

Arms (all read-only, same Sonnet 4.5, same repo):
- `oxagen-full` — `oxagen --readonly` cold (fresh HOME per question; full pipeline: context injection + completeness judge)
- `oxagen-lean` — `oxagen --readonly --no-pipeline` cold (fresh HOME per question; code_graph tool only, no judge tax)
- `oxagen-warm` — `oxagen --readonly` **warm** (persistent HOME across all questions and rounds; see below)
- `claude` — `claude -p` cold (Read/Grep/Glob)

Grading is deterministic substring matching (`TASKS[].require`). Results land in
`results.json` (git-ignored).

## Warm / self-improvement mode

The `oxagen-warm` arm measures whether **accumulated memory improves performance**
— the core claim of `eval-runbook §7` (H4).  It works by pointing the CLI at a
persistent, shared home directory so every lesson, trace, and fleet-memory entry
written while answering question N is readable by question N+1 (and by round 2,
round 3, …).

### How the memory dir is relocated

All of the CLI's persistent-state helpers call `node:os.homedir()`, which on
Linux/macOS reads the `HOME` environment variable.  Setting `HOME=<tmpdir>` in the
subprocess env redirects every store to `<tmpdir>/.config/oxagen/`:

| Store | File under `~/.config/oxagen/` |
|---|---|
| Trace store (per-turn telemetry) | `traces/<project>.json` |
| Fleet memory (lessons/recall) | `memories/<project>.jsonl` |
| DuckDB engram (episodic context) | `context.duckdb` |
| Fleet plan store | `fleet/<project>.json` |
| Settings | `settings.json` |

Confirmed in: `apps/cli/src/agent/trace-store.ts`, `fleet/memory.ts`,
`memory.ts`, `settings/resolve.ts`; and in the existing unit tests
(`apps/cli/src/agent/__tests__/fleet-memory.test.ts` sets `process.env["HOME"]`
to verify isolation).

**There is no `XDG_CONFIG_HOME` or `OXAGEN_HOME` env var in the CLI today.**
The only working override is `HOME`.

- **Cold arms** (`oxagen-full`, `oxagen-lean`) each receive a **fresh empty tmpdir**
  as `HOME` for every question, so no state bleeds across questions and the
  comparison is honest.
- **Warm arm** (`oxagen-warm`) receives one **shared persistent tmpdir** as `HOME`
  for the entire run (across all questions and all rounds).

The warm tmpdir is created at the start of `main()` and deleted at the end
(unless `OXAGEN_KEEP_WARM_HOME=1` is set to inspect the accumulated state).

### Learning-curve mode (`--rounds N` / `EVAL_ROUNDS=N`)

```bash
python bench/context-eval/run_eval.py --rounds 3
# or
EVAL_ROUNDS=3 python bench/context-eval/run_eval.py
```

Runs the full 6-question set **N times** for the warm arm, persisting memory
across rounds.  After each round the script prints accuracy / cost / tokens for
that round.  A final "WARM LEARNING CURVE" table shows all rounds side-by-side.

A **rising pass rate across round_1 → round_N** is the positive learning slope
— H4's monotonic-increase clause.  A flat or noisy curve falsifies it on this
question set (it may hold on harder reasoning tasks; see runbook §7.4).

### Wipe-reversion test (`--wipe-reversion`)

```bash
python bench/context-eval/run_eval.py --rounds 3 --wipe-reversion
```

After the warm rounds complete, **wipes the persistent memory dir** (same code,
same model, same questions — only the accumulated graphs are removed) and
re-runs the question set once.  The resulting row is labeled `wipe_reversion` in
the learning-curve table.

A **drop in pass rate to near round_1 (or cold baseline) after the wipe** is the
causal test — H4's causal clause.  If performance does *not* drop after the wipe,
the gains came from something other than the accumulated graphs (model drift,
easier question ordering, etc.) and the thesis is not supported.  Report that
honestly.

### Subset runs

```bash
OXAGEN_ARMS=oxagen-warm python bench/context-eval/run_eval.py --rounds 5 --wipe-reversion
OXAGEN_ARMS=oxagen-full,oxagen-warm python bench/context-eval/run_eval.py --rounds 2
```

### Configuration

| Env var | Default | Effect |
|---|---|---|
| `OXAGEN_ARMS` | all four arms | Comma-separated subset of `oxagen-full,oxagen-lean,oxagen-warm,claude`. |
| `EVAL_ROUNDS` | `1` | Number of warm rounds (equivalent to `--rounds`). |
| `OXAGEN_KEEP_WARM_HOME` | unset | Set to `1` to keep the warm tmpdir after the run so you can inspect accumulated memory. |
| `OXAGEN_CLI_BUNDLE` | repo build path | Override the path to `oxagen.mjs`. |
| `OXAGEN_MODEL_SLUG` | `anthropic/claude-sonnet-4.5` | Model slug for oxagen arms. |
| `CLAUDE_MODEL` | `sonnet` | Model flag for the `claude` arm. |
| `EVAL_TIMEOUT` | `300` | Per-question timeout in seconds. |

## Result (6 repo-structural questions, 2026-06-27)

| Arm | Accuracy | Total cost | Total tokens | Wall | Cost/Q |
|---|---|---|---|---|---|
| Claude Code (cold) | 6/6 | $1.097 | 492k | 36s | $0.183 |
| oxagen (full engine) | 6/6 | **$0.271** | 72k | 530s | $0.045 |
| oxagen (lean, code-graph) | 5/6 | **$0.145** | 47k | 33s | $0.024 |

**At identical accuracy (6/6), oxagen cost ~4.0× less and used ~6.8× fewer tokens
than Claude Code** — its local code-graph answers "where/what" structurally
(~8–14k tok/question) while Claude Code re-primes ~89k tokens of context on every
cold question to grep for the same answer.

Notes:
- `oxagen-lean` is ~7.6× cheaper and fast (3–4s/q) but missed one question
  (`proxy-file`: answered `instrumentation.ts`); the full pipeline's
  context-injection corrected it — the judge/enhancer buys back the accuracy.
- `oxagen-full` is slower (~88s/q) because its completeness-judge + advisor run
  every turn — a quality-gate cost, not a retrieval cost (lean proves retrieval
  is near-instant).
- `oxagen-warm` warm-run results pending (run `--rounds 3` to generate them).
- Caveats: n=6, factual/structural Q&A (not code-writing); Claude Code's
  per-question cost includes cache-creation it would amortize across a long
  interactive session (cold one-shot is the fair apples-to-apples here); harder
  reasoning could narrow the gap.

Contrast with the cold Terminal-Bench run (`../terminal-bench/`), where both
agents tied at 0/2 and the benchmark saw nothing — that's the floor; this is the
edge it misses.
