# ADR-173: The control plane seals a silent ledger attempt abandoned

- **Status:** Accepted
- **Date:** 2026-09-24
- **Owners:** platform
- **Amends:** ADR-159's consequences (ledger runs had no reaper).
- **Related:** ADR-043 (Oxagen runs no agent, so the seal is the only fence),
  ADR-058 (the seal grades a recording), ADR-159 (the idle close of a wrapped
  session), issue #3988.

## Context

A ledger run (`arun_…`) seals through `sealAttempt`, and only its producer
calls it: the in-app assistant when its turn settles, a preflight refusal, or
`approval-resume`. When the API process dies mid-turn (a deploy, an OOM, a
crash), nothing seals the attempt. The run reads as `live` on Fleet for good.
The nightly cost sweep never reaches it either, because a ledger run is
rolled up from its seal.

ADR-159 added an idle close for wrapped sessions only. It left ledger runs
out, because a ledger seal mints a finalization grant and commits the
attempt's stream digest, and closing an attempt on someone else's behalf
needed its own decision about who owns the attempt and what a late append
means.

The ledger already has the vocabulary for this. The terminal status
`abandoned` exists, and a seal with it records the `unobserved_tail` gap.
Before this decision no production code passed it.

## Decision

### 1. A scheduled close seals a silent attempt `abandoned`

`run.ledger-idle-close` runs every 15 minutes. It lists the open attempts of
evidence-grade (V2) runs: the run is `pending` or `running`, its
`active_attempt_id` names the attempt, and no seal row exists for it. It
takes those whose last activity is older than `LEDGER_IDLE_CLOSE_AFTER_MS`,
twelve hours. Last activity is the last event, or the claim when there is no
event, or a later operator resume (§4). That is the silence ADR-159
allows a wrapped session. An assistant turn records a frame at every model
and tool call and parks no longer than an approval's five minutes. A producer
on `/v1/run-ingest` refreshes a fifteen-minute credential with every batch.
Twelve silent hours means the producer is gone.

Each attempt is sealed through the ledger's own `sealAttempt`, in its
tenant's scope and its own transaction:

- `terminalStatus: "abandoned"`. The seal records `unobserved_tail`, which
  grades the recording `inspect`, and the run turns `failed`, the status an
  abandoned attempt has always given its run.
- `reasonCode: "idle_timeout"` and sealer `run.ledger-idle-close`, so a
  reader can tell this close from a producer's own abandoned seal.
- `agent_runs.error` reads "No event arrived for 12 hours, so Oxagen closed
  the attempt as abandoned."
- No terminal event. The ledger never invents an observation no producer
  made, so the seal commits to the events already durable.

Each closed run sends `cost/run.sealed`, so its cost is rolled up as final.
The nightly sweep reaches the run too, because it now has a seal.

### 2. The close is conditional on the head the scan read

`SealAttemptInput` gains `expectedAttemptSeq`. The scan reads the attempt's
last `attempt_seq` (0 when it has none) outside the run lock. The seal takes
the lock, reads the attempt's state, and throws `AttemptAdvancedError`
without writing anything if the attempt has moved past that head. A producer
that appends between the scan and the close keeps its attempt open.

When the producer sealed the attempt itself in that window, `sealAttempt`
returns the producer's seal marked `alreadySealed`, as it does for any
duplicate seal. The close counts neither case as a close and sends no event
for it.

### 3. The close is final, and a late append is refused

Unlike the idle close of a session, this seal is not reopened by later
evidence. A ledger seal is a different kind of record:

- It mints the attempt's finalization grant and obligation in the same
  transaction. The grant is one-shot and non-expiring. Reopening the attempt
  would leave a grant for a stream that no longer ends where the grant says.
- It commits the attempt's stream digest and writes the archive segment the
  compacted attempt is read from. A reopen would make both wrong.
- "The seal is the fence" is the ledger's one serialization rule since
  ADR-043 removed leases. An exception for one sealer would be a second rule.

So a producer that comes back after the close finds its attempt sealed. Its
append is refused with `AttemptNotWritableError` (`sealed`), exactly as after
any seal, and a surface answers it as a conflict (`run_not_writable`). The
producer's work belongs in a new run. The in-app assistant already opens a
new run for every turn and for every approval it resumes, so it never meets
this case.

A cancelled run whose producer died is closed the same way. Its seal reads
`abandoned` and its run `failed`, because no producer observed the end. The
cancel's applied receipt stays on the run.

### 4. An operator's pause or resume holds off the close

An operator can pause a ledger run's evidence ingress (`dispatch_command`
with `pause`). While it is paused, every append is refused, so the run is
silent because the operator asked for it, not because the producer is gone.
Two rules follow:

- **A paused run is never closed.** The scan leaves out every run whose
  `ingress_paused` is set, however long the pause lasts. Sealing it would end
  a run the operator means to resume, record the operator's pause as the
  producer's failure, and leave nothing to resume, because a resume refuses a
  run that has ended.
- **A resume is activity.** Silence counts from the later of the last event
  (or the claim) and the run row's `updated_at`. `setRunIngressPaused` stamps
  `updated_at`, so a resume starts a fresh twelve hours. Without this, a run
  resumed after a pause of twelve hours or more would be closed at the next
  pass, before its producer could append. Every append stamps `updated_at`
  as well. Other writes to the row, such as a cancel or a requested summary,
  stamp it too. They can only make the close later, never earlier.

## Consequences

- A ledger run whose producer died reads as ended on Fleet and the Run page
  within twelve hours and fifteen minutes, and its cost reads as final.
- A producer that is silent for twelve hours and then comes back loses its
  attempt. That trades a rare, long pause for a record that never stays open
  for good.
- The scan reads every organization's open attempts through `withSystemDb`,
  as the wrapped-session close does, and seals each in its tenant's scope. An
  organization on a dedicated plane (ADR-042) gets no close until the ledger
  learns planes.
- The first passes close the backlog of attempts that never sealed, 500 each
  quarter hour, oldest first. Each closed run sends `cost/run.sealed`.
- An attempt whose close fails is left for the next pass. Within one pass,
  each further scan leaves out the attempts the pass already tried, up to
  four scans, so attempts that fail every time cannot fill every batch. The
  completion log counts the failures.
- The scan reads the pause flag outside the run lock, and a seal with no
  terminal event does not check it. A pause that lands in the moment between
  the scan and the seal of a run already silent for twelve hours does not
  stop that close.
- A run admitted with no attempt behind it (a crash between `createRun` and
  `createAttempt`) is not an attempt and is not closed here.

## Alternatives rejected

- **Reopen the attempt on a late append,** as ADR-159 reopens a session. It
  would contradict the grant and stream digest the seal committed to. See §3.
- **Open a new attempt for the late producer automatically.** The producer
  holds a credential bound to the old attempt, and an attempt carries a
  pinned engine identity and a place in the run's `max_attempts`. Choosing
  that on the producer's behalf is the runtime work ADR-043 removed.
- **Derive "stopped reporting" on read.** It seals nothing, so the run would
  never get a final cost and the nightly sweep would never reach it.
