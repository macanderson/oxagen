# ADR-199: Run steps are graded from recorded outcomes and set beside the agent's last 30 days

- **Status:** Accepted
- **Date:** 2026-09-26
- **Owners:** billing, run
- **Related:** issue #3984, issue #3892, issue #4001, ADR-060 (the cost
  rollup), ADR-062 (findings), ADR-064 (the witness verdict),
  `docs/capabilities/run.cost.md`, `packages/billing/src/step-grade.ts`,
  `packages/handlers/src/lib/run-cost-baseline.ts`.

## Context

The Run page's Cost tab draws a productive ratio, a cost figure, and a list
of tools. Three things it printed had no record behind them.

1. **The productive ratio.** `cost.run_totals.productive_ratio` existed, and
   nothing computed it. The rollup copied the column from the existing row,
   and the upsert kept it in the columns a rebuild carries, which the
   conflict update leaves out. A value written once could never change.
2. **The agent's median run and its 30-day ratio.** The mockup draws "+$1.24
   vs this agent's median run $2.89" and "+9 pts vs 30-day 62%". No read
   answered either, so the tiles said "not recorded".
3. **What each tool cost.** The rollup counted each tool's calls and nothing
   else. The OTel tool spans record each call's result tokens, and the
   findings job already prices a result at the run's own input rate.

The recorded outcomes a step can be graded on are these: a tacho hook's
`tool_status`, a ledger call's `outcome`, the input and output digests of
each call, the classifier's mutating flag, and the session's API retry
count. Nothing records a wait.

## Decision

### 1. A step is graded from what its frame recorded

A step is one model call or one tool call. The rollup grades every step of a
run as it rebuilds the row (`gradeSteps` in `step-grade.ts`). A step is
unproductive for one cause at most:

- **`failed`:** a tool call whose status is `error` or `rejected`. A ledger
  call's `failed` and `denied` outcomes map to those. A cancelled call and one
  parked on an approval did not fail and are not graded as waste.
- **`repeated`:** a tool call with the same tool, input digest and output
  digest as an earlier call of the run, when it is a shell command or a call
  the classifier marked read-only. This is the findings job's rule for
  `repeated_shell_commands` and `duplicate_tool_calls`, and the two share one
  predicate (`RepeatedCalls`, `repeatKindOf`). A repeat of a call that writes
  may be doing new work, so it is not counted.
- **`retried`:** the session's API retries, one model call each, never more
  than the run's model calls.

A step whose frame hides its outcome counts as advanced: the rollup does not
call a step waste on evidence it cannot read. `advanced_steps` is
`steps - unproductive_steps` by construction, `productive_ratio` is
`advanced_steps / steps`, and a run with no step is not graded (all three
null). The causes ride the breakdown jsonb, so they need no column.

The rollup owns the three columns. `upsertRunTotals` writes them on every
rebuild, which fixes the stale ratio in Context item 1.

### 2. A tool's cost is its result tokens at the run's input rate

Each tool's result tokens are summed from its calls' spans and priced at the
run's uncached input rate (`runInputPrice`, moved from the findings job into
`cost-rollup.ts` so both price a token alike). The figure is always labelled
`estimated`. It attributes input the run's cost already counts, so it never
adds to the run's cost, and the daily tool groups keep a null cost. An
`estimated` run has no input price, so its tools carry none. A tool none of
whose calls recorded result tokens has no cost, never a zero.

### 3. The baseline is the agent's sealed runs in the 30 days before the run

`get_run_cost` answers a baseline beside the row:

- The window is `[startedAt - 30 days, startedAt)` for the run's agent in its
  workspace. It is anchored at the run's start, not at the read, so a sealed
  run's delta does not drift as the agent keeps running.
- Only sealed runs count. An open run's figures are a running estimate
  (#3980). The run itself is left out.
- The median is `percentile_cont(0.5)` of the costs priced in the run's
  currency, rounded half to even to whole micros, with the fold of their
  bases.
- The ratio is `sum(advanced_steps) / sum(steps)` over the graded runs. A
  mean of ratios would let five two-step runs outweigh one run of two
  hundred steps.
- The minimum is `RUN_COST_BASELINE_MIN_RUNS = 5`, applied three times: to
  the sealed runs (below it the baseline is null), to the priced runs (below
  it the median is null), and to the graded runs (below it the ratio is
  null).

Postgres folds the window into one row, and `run_totals_agent_started_idx`
on `(workspace_id, agent_key, started_at)` serves the read.

### 4. A finding cites frames, by chain

The findings job stores the frame of every call it cites, in every run it
cites, in `cost.findings.cited_frames`: seqs ascending, at most
`FINDING_FRAMES_PER_RUN = 50` per run, with a total. A subagent's call names
its chain, because its seq counts on that chain alone. A finding about a
run's cache use cites the run as a whole and stores no frames. No column
changes.

## Alternatives

- **Grade from the model's own words.** Rejected. A judge over the turn text
  is a guess that costs a model call per run, and a person cannot check it
  against the record.
- **Count a wait as unproductive.** Rejected for now. Nothing records one, and
  a count built on inference would be printed beside counts the record backs.
- **Add each tool's cost to the run's cost.** Rejected. The result tokens are
  already inside the model calls' input, so adding them counts that input
  twice.
- **Anchor the baseline window at now.** Rejected. A run's delta would change
  every day after it sealed, and the Run page would print a different figure
  for the same finished run.
- **A mean of the window's ratios.** Rejected for the reason in decision 3.

## Consequences

- A migration adds `advanced_steps`, `unproductive_steps`,
  `run_totals_steps_graded_check` and `run_totals_agent_started_idx`, with no
  backfill. A row rolled up before this change answers null for the grade
  until its next rollup, and its tools answer no cost.
- A ledger run records no read-only flag and no result tokens, so its repeats
  are not graded and its tools carry no cost. Its failures are.
- The composition of a run's input (tool definitions, context, steering) is
  still not measured, so the Cost tab's composition meters stay not recorded
  (#3894).
