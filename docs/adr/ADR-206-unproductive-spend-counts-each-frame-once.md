# ADR-206: Unproductive spend counts each model-call frame once

- **Status:** Accepted
- **Date:** 2026-09-26
- **Owners:** billing, spend
- **Related:** ADR-062 (the findings job and its detectors), ADR-199 (a run's
  steps are graded from recorded outcomes), ADR-205 (a run's reads cover every
  chain), the unproductive spend build plan (lane F1).

## Context

The spend page will lead with one number: the unproductive spend over the
window, with a total per operator. Eight detectors feed the findings job, and
two of them can name the same model request. A request that only repeated a
call inside a loop is a spin loop, a repeated tool call, and possibly part of
a recurring run. If each finding added its own saving to the headline, that
request would count two or three times.

The findings job priced a repeat per tool call: the result tokens at the
run's input price. That prices a part of a request. It does not say what the
request cost, and it cannot be deduplicated against a finding that prices the
whole request.

The detectors are numbered as the build plan numbers them:

| Detector | Kinds |
|---|---|
| 1 | `spin_loops`, `repeated_shell_commands`, `duplicate_tool_calls` |
| 2 | `standing_context` |
| 3 | `idle_cache_rewrites`, `cache_busts` |
| 4 | `model_class_fit` |
| 5 | `unpaged_results` |
| 6 | `repeated_instructions` |
| 7 | `recurring_runs` |
| 8 | `spend_with_no_outcome` |

`cache_writes_never_read` predates the numbering. It prices a part of each
request, as detector 3 does.

## Decision

1. **The headline adds detectors 1, 7, and 8, and a frame counts once.** A
   finding from one of these detectors claims the model-call frames it prices
   whole. A frame counts under the first detector in the order 1, 7, 8 that
   claims it. Each operator's total is the frames counted under that
   operator's runs, with one more bucket for runs that name no operator, so
   the operator totals sum to the headline. This is counting rule 1 in the
   build plan, and it was decided there.
2. **Detectors 2, 3, 4, and 5 claim no frame.** Each prices a part of a
   request, so none of them adds to the headline. Counting rule 2 keeps 2, 3,
   and 5 out of the sum. Detector 4 is labelled estimated (counting rule 3,
   proposed), and it stays out of the sum for the same reason.
3. **`cost.finding_claims` stores the claims.** One row per finding, run, and
   frame: the detector, the run's public id, the frame key, the frame's time,
   the operator key, and the frame's priced cost. It carries the tenant
   columns every table carries, a foreign key to `cost.findings` that
   cascades on delete, and a unique index on (finding, run, frame key). A pass
   that rewrites a finding deletes its claims and writes the new ones in the
   same transaction. A pass that no longer proves a finding deletes the
   finding, and its claims go with it.
4. **`readUnproductiveSpend` reads the headline.** It selects the claims of
   the workspace's open and applied findings whose frame falls in the window,
   and `countClaims` keeps the lowest detector per (run, frame key). A
   dismissed finding's claims do not count.
5. **A frame key is the store's `at` text, then `#`, then its position.** The
   store prints `at` with microseconds, and a JavaScript `Date` keeps
   milliseconds. The key keeps the store's text, and the position (0, 1, 2)
   separates frames of one run at the same instant. The job sorts those
   frames by their content before it numbers them, so a frame keeps its key
   whatever order the store returns them in. Two frames with the same content
   are interchangeable, so their order does not matter.
6. **A request counts only when every tool call it made is a repeat.** The
   repeat rule is the rollup's (ADR-199): the same tool, input digest, and
   output digest as an earlier call of the run, on the `Bash` tool or on a
   call the classifier marked read-only. Such a request did no work the run
   needed, so its whole priced cost is the measured side and the
   counterfactual is 0. A request that also made one new call does not count.
   The evidence counts requests, and the prose calls them turns.
7. **A tool call belongs to the latest frame of its run at or before it.**
   The job compares the microseconds the store printed for both, since two
   events of one millisecond would otherwise tie.
   Model-call frames carry no chain, so a subagent's call can land on a
   parent's frame that ran just before it. Calls before a run's first frame
   form a request with no frame. It is cited and not priced.
8. **A spin loop is 20 or more repeats of one call in a row on one chain.**
   The job orders each chain by `seq` and finds streaks of the same tool,
   input, and output. A request counts toward `spin_loops` when every call it
   made is a repeat and one of them is in such a streak. The spin loop
   detector runs before the repeat detector and claims its frames first, so a
   request in a loop is never also a repeated tool call.
9. **A repeat or loop finding is cited at the run's agent, or at its operator
   when it names no agent.** `repeated_shell_commands` stays at the `Bash`
   tool. A run that names neither an agent nor an operator has its read-only
   repeats left to `unpaged_results`.
10. **The job reads frames for at most 200 runs a pass.** It reads the runs
    with the most repeats first. A run past the cap, or one whose frames did
    not load, has its repeats cited with no price. They do not count toward a
    finding's coverage, and they claim no frame.
11. **A pass keeps at most 10 findings per kind and 50 in all.** Only a
    written finding stores claims, so a frame claimed by a finding below the
    cut does not reach the headline. `list_findings` answers at most 50, so
    every open finding still fits one answer.

## Consequences

- The headline is a sum over stored claims, so it reads in one query and
  counts each frame once. A detector that lands later (7 and 8) writes
  claims with its own number, and the reader needs no change.
- A repeat finding's saving now reads as whole requests. It is larger than
  the per-call price when a request carried a large context, and it is 0 for
  a request that also did new work.
- The job skips the "no mutating call between" clause of the spin loop
  definition. The rollup's repeat rule already requires the same output, and
  a write between two identical reads that changes what they return breaks
  the repeat.
- Attribution by time can put a subagent's call on its parent's frame (7).
  The fix is a chain on the model-call frame, which the recorder does not
  write yet.
- Runs past the 200-run frame cap (10) are cited and not priced, so a large
  workspace can under-count. The cap bounds the ClickHouse reads of one pass.
