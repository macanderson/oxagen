# ADR-159: A run is costed while it runs, and the control plane closes a silent session

- **Status:** Accepted
- **Date:** 2026-09-24
- **Owners:** platform
- **Amends:** ADR-060 §3 (the run rollup ran only at the seal, and the tacho
  ingest handler was the one seal writer).
- **Related:** ADR-058 (the seal grades a session), ADR-064 (the verdict the
  rollup carries), ADR-142 (a run keeps the cost center of its first rollup),
  issue #3980.

## Context

A wrapped session sealed only when its host sent an `agent_stop`. The host
sends one on the harness's `SessionEnd` hook, or from the daemon's sweep
(`SessionRegistry.sweep`), which seals a session once its harness process is
gone or, with no process to watch, after six idle hours. Nothing on the server
ever sealed anything.

Three cases never reach an `agent_stop`:

- A Claude Code terminal left open. `CLAUDE_PID` stays alive, so the sweep
  waits on it for as long as the terminal is open.
- A host whose daemon stopped, or a machine that is gone. Nothing seals while
  the daemon is down, and nothing at all if its `state.json` is lost.
  Claude Code's `SessionEnd` is an HTTP hook with no spool, so it is lost
  while the daemon is down.
- A subagent chain whose `SubagentStop` was missed. The root's `SessionEnd`
  seals only the root.

Those runs read as `live` for days.

Cost had the same dependency. `cost.run_totals` was rebuilt only on
`cost/run.sealed` and by the nightly sweep of sealed runs, so Fleet, the Cost
tab and Spend showed nothing for a run until it sealed, and nothing at all for
a run that never did. The rollup itself never needed the seal:
`rebuildRunTotals` reads whatever frames the stores hold.

## Decision

### 1. The rollup runs while the run does

Tacho ingest sends `cost/run.progressed` after every batch that lands a model
or tool frame, unless that batch also sealed the run, in which case the seal
sends `cost/run.sealed`. The event goes out after the ClickHouse append, for
the reason the seal event does. A root sealed earlier still gets the event,
because a subagent's chain or a harness that carried on after a sweep can land
frames after the seal's rollup, and nothing else counted them. A re-send that
writes model or tool frames ClickHouse lost gets it too: the attempt whose
append failed sent nothing, and the re-send's fold sees the frames as already
recorded.

`cost.run-progress` consumes it. It is debounced per run (`period` 30 s,
`timeout` 2 min), so it runs 30 seconds after the latest batch and at least
every two minutes while batches keep arriving. It rebuilds the run's row and
the workspace-day's groups, and runs one at a time per workspace, because
every run of a workspace-day rewrites the same group rows. It requests no
findings pass: findings judge a finished run, and the seal's rollup requests
one.

`DurableFunctionConfig` gains `debounce`, passed to Inngest in its own shape.

### 2. An open run's figure is an estimate, and every surface says so

A row rebuilt while the run was open carries `sealed_at` null. That is the one
signal:

- `get_run_cost` answers `isEstimate`: true when the row's `sealed_at` is null.
- `list_runs` and `get_run` answer `costIsEstimate`: true when the run is open,
  or when its row was rebuilt before the seal and the seal's rollup has not
  landed.
- `get_spend` answers `estimatedRuns`, the period's runs whose row was built
  while they were open. Their running cost is in every figure.

The Run page labels the Cost stat, the Cost tab and "Spend by area" as
estimates. Fleet marks the row's cost cell and counts the estimates in Spend
shown. Spend reads "Includes estimates" on its Cost data tile. With no rollup
yet, the agent's own report stays on the Run page as an estimate of its own.

Three guards keep the running rollup from corrupting the record:

- `upsertRunTotals` refuses a write that would replace a sealed row with an
  open one while the run is sealed as the statement runs. The progress and
  seal rollups are separate functions with separate concurrency keys, and a
  progress rebuild that read the run just before its `agent_stop` could
  otherwise land last and put a finished run back to an estimate. The run's
  live seal decides, not a frame count: a run reopened by a frame with no
  model call counts the same frames as its sealed row, and its rebuild must
  land. A ledger run never reopens, so its sealed row is never replaced by
  an open one.
- The seal's own rebuild always lands over a row built while the run was
  open, even when it prices less. Refused, the nightly sweep would list the
  run every night. A stale price is the repricer's to repair.
- `rebuildDailyTotals` holds a transaction-scoped advisory lock on the
  workspace-day from its read to its write. Two concurrent rebuilds of one day
  each deleted rows the other had not committed, and the second insert failed
  on `daily_totals_group_idx`. A rebuild that read before waiting on the lock
  would write an older snapshot over a newer one. Running rollups make that
  pair common.

The nightly sweep also rolls up a sealed run whose row was built while it was
open, so a lost seal event cannot leave a finished run as an estimate.

A run's cost center is fixed by its first rollup (ADR-142). That rollup now
happens while the run is open rather than at its seal, so a run is charged to
the label its agent carried when it ran.

### 3. The control plane closes a run that stops reporting

`tacho.session-idle-close` runs every 15 minutes. It closes an open session
once every chain of its run, root and subagents, sealed or not, has sent
nothing for `TACHO_IDLE_CLOSE_AFTER_MS`: twelve hours. The run-wide silence is
asked again by the close's own UPDATE, not only by the scan, and scoped to the
session's organization. That is twice the
daemon's own six-hour sweep, so a running daemon decides first with better
facts. The close writes, in the session's tenant scope:

- `seal_source = 'idle_timeout'`, a new column. A host's `agent_stop` writes
  `agent_stop`. A row sealed before the column existed holds null and reads as
  `agent_stop`.
- `outcome = 'unknown'`. A run that may have finished is not a run that
  finished, which is what `unknown` already meant on `list_runs`.
- `ended_at` = the last event received, and `sealed_at` = when the close ran.
- `final_hash` = the chain head the control plane holds. The host never
  committed to an end.
- The gaps and grade `sealTachoSession` gives the session's own counters plus
  `unobserved_tail`. That grades `inspect`.

A closed root sends `cost/run.sealed`, so its cost reads final. The statement
is conditional on the head and the silence the scan read, and ingest's update
is conditional on the seal state it read, so a close and a batch that race
cannot both win. Whichever commits second finds the row changed and gives
way, and a refused batch is re-sent.

`sealTachoSession` moved to `@oxagen/tacho`, beside the grade it computes, so
ingest and the close grade with one rule.

### 4. The close is an inference, so it stays open to correction

A host's seal is final: "a sealed session is never sealed again." The idle
close is not. It is the control plane reasoning from silence, and it gives way
to evidence:

- A batch with new frames and no `agent_stop` reopens the session. Ingest
  clears exactly the columns the close wrote (`IDLE_CLOSE_UNDONE`, checked
  against `idleCloseColumns` by a test), the session reads as running again,
  and its cost is an estimate again: the reopen asks for a rollup whatever
  the batch carried.
- A subagent's fresh frames reopen its idle-closed root, conditional on the
  close still standing. A run is one piece of work across its chains.
- A batch with an `agent_stop` replaces the close with the host's own seal and
  sends `cost/run.sealed`.
- Ingest's update of an open session is conditional on `sealed_at` still being
  null. A close that committed between the batch's read and its write makes
  the batch a conflict, and the daemon's re-send reopens the session.

Three gates treat the close as the provisional thing it is:

- `export_run` refuses an idle-closed run as it refuses a live one. A signed
  bundle over the close would attest a head, gaps and grade that a reopen or
  the host's seal replaces.
- `dispatch_command` queues a command for an idle-closed run instead of
  recording it failed. The harness may be alive, and the host delivers the
  command on its next poll.
- `list_runs`, `get_run` and the Run page read a run that is open as an
  estimate whatever its row says. `get_run_cost` reads the row, which the
  reopen's rollup rebuilds open.

The enforcement tier may still rise under an idle close. Nothing was signed on
the strength of the close that a later seal could contradict.

The Run page shows an idle-closed run as "closed <time> (no event for 12
hours)" and leaves its wall clock unrecorded, since the seal time is the
close, not the end.

## Consequences

- Every root with model or tool activity costs one debounced rollup every two
  minutes at most while it runs. Each rollup re-reads the run's frames from
  ClickHouse.
- Spend, the cost-center statement and the findings pass can read an open
  run's running estimate. `get_spend` says how many runs that is, and the page
  says so.
- A resumed Claude Code session that sat idle for twelve hours reads as closed
  until its next frame lands.
- Ledger runs (`arun_…`) get no running rollup and no reaper. The in-app
  assistant seals its run when the turn settles, and a run whose API process
  died mid-turn stays open. That needs a `sealAttempt` with status
  `abandoned` on the ledger (#3988).
- The daemon's gaps stay. A root `SessionEnd` still does not finalize open
  subagent chains, Codex and Cursor still carry no pid, and Claude Code's
  `SessionEnd` still has no spool. The idle close bounds each at twelve hours
  rather than fixing them on the host (#3989).
- The close and the running rollup read the shared data plane
  (`withSystemDb`), as the rest of the rollup store does. An organization on a
  dedicated plane (ADR-042) gets neither until that store learns planes.

## Rollout

- The first passes close the backlog of sessions that never sealed, 500 each
  quarter hour, oldest first. Each closed root sends `cost/run.sealed`, and
  each of those requests a findings pass over its workspace.
- A root with steady activity costs one rollup every two minutes at most, and
  each rebuild re-reads the run's frames from ClickHouse and rewrites its
  workspace-day. Progress rollups run one at a time per workspace.

## Alternatives rejected

- **A final server seal.** It is simpler, but a resumed session would read as
  sealed while it ran, its commands would be refused, and the host's own
  `agent_stop` would be dropped when it finally arrived.
- **Deriving "stopped reporting" on read.** It seals nothing, so a stuck run
  would never get a final cost and the nightly sweep would never reach it.
- **Reading the session's own `total_cost_micros` before the seal.** ADR-060
  moved every cost read to the rollup so one run has one figure. That column
  covers the root chain only, and the price book never priced it.
