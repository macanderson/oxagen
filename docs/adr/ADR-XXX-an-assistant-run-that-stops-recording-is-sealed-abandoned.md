# ADR-XXX: An assistant run that stops recording is sealed abandoned

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** platform
- **Amends:** ADR-159 (its consequences left a ledger run whose process died
  open, with no reaper).
- **Related:** ADR-042 (data planes), ADR-043 (the seal is the fence),
  ADR-058 (the seal grades a run), ADR-169 (an operator's seal is final),
  issue #3988.

## Context

The in-app assistant records every turn as a ledger run (`arun_…`). The run
opens before the engine is asked anything and seals when the turn settles
(`AssistantRun.seal` in `packages/agent/src/runtime/assistant-run.ts`).
`approval/resume` opens and seals one the same way for each approved call it
runs. Nothing else seals a ledger run.

A deploy, an OOM or a crash between the open and the seal leaves the run
`running` for good. Fleet reads it as live, and the nightly cost sweep never
reaches it, because `listRunsAwaitingRollup` rolls up only ledger runs that
carry a seal.

The ledger already had the vocabulary. The seal table admits the terminal
status `abandoned`, `deriveCompletenessGaps` adds `unobserved_tail` for it,
and a zero-event attempt seals with the canonical empty-stream digest. No code
wrote it. ADR-159 closed silent wrapped sessions and left ledger runs out,
because a ledger seal mints a one-shot finalization grant and needed its own
rule.

## Decision

1. **A sweep closes a silent assistant run.** `evidence.assistant-run-abandon`
   runs every five minutes. It lists open V2 runs on the two surfaces an
   assistant turn is admitted on, `chat` and `api-chat`, whose last sign of
   life is older than `ASSISTANT_RUN_ABANDON_AFTER_MS`. The last sign of life
   is the server time of the open attempt's last frame, else the time the
   attempt opened, else the time the run was admitted. Each scan takes the
   oldest silence first, at most 200 runs, once for the shared plane and once
   for each workspace on a dedicated plane.

2. **The limit is twice the engine's deadline.** A live turn writes a frame
   before and after every reverse request, and the engine gives up on a
   request after `ENGINE_REVERSE_REQUEST_TIMEOUT_MS` (six minutes). A request
   that runs out the deadline fails the turn, and the turn seals its own run.
   The limit is `2 * ENGINE_REVERSE_REQUEST_TIMEOUT_MS`, twelve minutes today,
   so a turn whose process is alive decides first. The second deadline is the
   margin. It covers a streamed completion, whose deadline restarts on every
   delta batch, and the seal a failing turn still has to write. The limit is
   derived from the engine's constant, so a change to one moves the other.
   The rule keys on silence, not age. A turn has no overall ceiling (up to
   twelve steps, each bounded by the deadline), and a long turn that keeps
   recording is never swept.

3. **The close is a compare-and-set** (`RunStore.abandonRun`). One UPDATE
   fails the run only while it is `pending` or `running`, still points at the
   attempt the scan read, and still holds the `next_run_seq` the scan read.
   Every append moves `next_run_seq` and every seal moves `status`, both on
   that row. A turn that appended or sealed after the scan therefore wins,
   and the close writes nothing. A second sweep finds the run closed and
   writes nothing either. The UPDATE also takes the run row's lock, which
   every append and seal waits on, so the seal written after it in the same
   transaction cannot race them.

   The sweep is the first writer that can seal an attempt while its producer
   may still append, so every append and seal now takes that lock in a
   statement of its own before it reads the seal.
   Under READ COMMITTED a statement reads from the snapshot it started with,
   even after it waits on a lock. An append whose one statement both waited on
   the close's lock and read the seal would miss the seal the close committed,
   and its frame would land on a sealed attempt. Read in the next statement,
   the seal is visible and the append is refused.

4. **The seal records only what the ledger saw.** The open attempt seals
   `abandoned` with the reason `producer_silent`, from the rows already on the
   ledger. No terminal event is appended, because nothing observed the end.
   The seal commits to the recorded head, carries `unobserved_tail`, and
   grades `inspect`. The run's status is `failed`, the mapping an abandoned
   seal already had, and its error names the rule. A run that never got an
   attempt fails with no seal. The seal's `sealer_kind` stays `ingress`,
   because ADR-043 retired `reclaimer`. The reason code and the
   `sealer_worker_id`, `evidence.assistant-run-abandon`, say what closed it.

5. **The seal is final, and a late producer is refused.** An append to the
   abandoned attempt raises `AttemptNotWritableError` with the reason
   `sealed`, as an append to any sealed attempt does. The refused receipt
   rejects the reverse request it belongs to, and `runGovernedTurn` turns
   that into a cancelled turn, so no answer built on an unrecorded step
   reaches the person. A late `sealAttempt` returns the
   abandoned seal's handle with `alreadySealed: true` and appends nothing. No
   new attempt opens: an assistant run pins `max_attempts: 1`, and the
   engine's state died with the process. This differs from ADR-159's idle
   close, which a later frame reopens. A wrapped session's seal is columns on
   its row. A ledger seal is the fence (ADR-043) and has already minted a
   finalization grant, so reopening it would mean revoking authority the
   ledger handed out.

6. **The cost is rolled up as final.** Each run the sweep closes sends
   `cost/run.sealed` with the dedup id `cost-run-sealed:<run>:abandoned`. The
   nightly sweep reaches the run too, because it now carries a seal.

7. **A dedicated plane is swept in its own scope.** The sweep scans the shared
   plane once through `withSystemDb` and leaves out every organization on a
   dedicated Postgres plane (ADR-042). It scans each workspace of those
   organizations in its own tenant scope and its own step, as
   `approval/resume` does, so an unreachable plane is logged and the rest go
   ahead.

## Consequences

- A run whose process died reads as live for at most seventeen minutes:
  twelve of silence and one five-minute pass. It then reads as failed, and
  its seal says `abandoned` with an unobserved tail.
- A single streamed completion that runs past twelve minutes with no frame is
  the one live turn the rule can close. Its next receipt is refused, and the
  turn is cancelled.
- `approval/resume` opens its run on `chat`, so the sweep also closes a resume
  whose process died. A resumed tool call that runs past twelve minutes is
  closed the same way.
- The cost rollup reads ledger runs from the shared plane (ADR-159). A run on
  a dedicated plane is sealed, but its `cost/run.sealed` finds no run until
  the rollup store learns planes.
- Ledger runs on `external`, `a2a` and `repo-edit` are not swept. Their
  producers set their own pace, and no deadline bounds them.

## Alternatives rejected

- **Key the rule on the run's age.** A turn has no overall ceiling, so an age
  limit would close live turns. Silence is what a dead process shows.
- **Read the run, then write.** The scan's read is stale by the time it
  writes. Making that read the condition of the UPDATE lets a turn that moved
  win.
- **Open a new attempt for a late producer.** The assistant pins one attempt,
  and a turn whose process died has no engine state to continue from.
- **Record the run as `cancelled`.** Nobody cancelled it. `abandoned` says
  that no producer observed the end.
