# ADR-190: A failed WAL write leaves every file as it found it

Status: Accepted

Date: 2026-09-25

Supersedes: ADR-185's Limits section, and the model proxy clause of its Decision 3

Related: #4311, #4299, #3372, #4301, #3944 (C-05), ADR-139, ADR-185

Code references name the method. `Wal` is in `packages/tacho/src/host/wal.ts`, the daemon's writers are in `packages/tacho/src/collector/daemon.ts`, and the model proxy is `packages/tacho/src/collector/model-proxy.ts`.

## Context

ADR-185 recorded that a failed WAL body write throws, and that the daemon's writers roll back the seal so the retry lands at the same seq. Its Limits section named four places where that did not hold, and #4311 tracked them:

1. A write across several sessions was not all or nothing. When `Wal.append` wrote a second session's event file and it threw, the first session's file kept its events and its `lastSeq` stayed advanced. Every caller rolled back each chain it had marked, so that session's recorder stood behind its WAL tail, and the seq guard refused its next write until the daemon restarted. The checkpoint writes one event per live session in one call, so it failed on every tick.
2. A failed call could leave body lines behind. #4301 cut them back for each session whose events did not land. A session whose event file the call did write kept its bodies.
3. The model proxy sealed its `llm_call` and `policy_decision` frames with no chain mark, so a failed write left its recorder one seq past the WAL's tail, and the next frame sealed a gap.
4. No daemon test drove a real body-write failure. Each one replaced `wal.append`.

## Decision

1. **A call to `Wal.append` is all or nothing.** It records the size of every event and body file it will touch before it writes. When any write throws, each file goes back to that size, a file the call created is removed, and each session's `lastSeq` and `cursor.sealed` entry go back to what they held. A body for an event already on disk, which `appendRecovered` writes, is cut back with the rest, and the retry writes it again.
2. **Every caller's rollback is now correct as written.** The checkpoint and `rollbackEveryChain` roll back every chain they marked, and the WAL now holds nothing past those marks. The checkpoint's comment, "a write that throws leaves none of them on disk", is now true.
3. **The model proxy rolls back.** `settle` takes a chain mark before `settleMetered` seals the call's frame and rolls back when the write throws. The refusal path does the same around its `policy_decision` frame and still answers the call 502. When the call frame's write fails, `settle` also forgets the request the proxy remembered as the session's next prior, so the next call stores its request whole rather than pointing at a body that never landed.
4. **Reads that ADR-185 Decision 6 lists moved to the tail.** `head`, `compact`, `lastSeqOf`, and `appendRecovered` read back from the end of the event file (`eventsBackward`), because the file is in seq order and the whole-file read stalled the daemon (C-05). They skip and report a line that does not parse, as `read` does.

ADR-185 keeps the rest of its decision. The SessionEnd terminal still retries from its journal. The daemon's genesis and shutdown seals still take no mark.

## Consequences

Each of ADR-185's four limits is gone:

- A write across several sessions leaves no session ahead of its recorder.
- A failed call leaves no body line behind, for any session in it. A crash between the body write and the event write can still leave an orphan. The daemon cuts it at its next startup (`repairOrphanBodies`), and until then the index keeps the last line for an event id.
- The model proxy's failed write leaves no gap.
- A daemon test drives a real body-write failure through a hook.

A failed cut-back is reported through the body failure sink and left for startup repair. The caller still gets the write's own error.

## Evidence

- `packages/tacho/src/host/wal.test.ts`, "a write across several sessions" (three cases)
- `packages/tacho/src/collector/daemon-checkpoint.test.ts`, "lands for both sessions on the next tick after the second session's file refused the write"
- `packages/tacho/src/collector/model-proxy.test.ts`, "gives a call's seq to the next call when its frame never reached the WAL, with no gap and no fold against the lost body" and "gives a refusal's seq to the next frame when its frame never reached the WAL"
- `packages/tacho/src/collector/daemon-bodies.test.ts`, "answers a hook 500 when its body cannot be written, and lands the replay at the same seq with one body"
- `packages/tacho/src/host/wal-read-cost.test.ts`, for the tail reads in Decision 4
