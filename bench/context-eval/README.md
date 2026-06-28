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
- `oxagen-full` — `oxagen --readonly` (full pipeline: context injection + completeness judge)
- `oxagen-lean` — `oxagen --readonly --no-pipeline` (code_graph tool only, no judge tax)
- `claude` — `claude -p` cold (Read/Grep/Glob)

Grading is deterministic substring matching (`TASKS[].require`). Results land in
`results.json` (git-ignored).

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
- Caveats: n=6, factual/structural Q&A (not code-writing); Claude Code's
  per-question cost includes cache-creation it would amortize across a long
  interactive session (cold one-shot is the fair apples-to-apples here); harder
  reasoning could narrow the gap.

Contrast with the cold Terminal-Bench run (`../terminal-bench/`), where both
agents tied at 0/2 and the benchmark saw nothing — that's the floor; this is the
edge it misses.
