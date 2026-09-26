# ADR-185: A failed WAL body write rolls back the seal

Status: Accepted; the Limits section and the model proxy clause of Decision 3 superseded by [ADR-190](ADR-190-a-failed-wal-write-leaves-every-file-as-it-found-it.md) (2026-09-25)

Date: 2026-09-25

Supersedes: two decisions in ADR-127, "The WAL still attempts the sealed event append" and "Event reads remain strict"

Related: #3365, #3822, ADR-126, ADR-127, ADR-139

Code references name the method and describe the tree at `7dfcd0b95`. `Wal` is in `packages/tacho/src/host/wal.ts`, and the daemon's writers are in `packages/tacho/src/collector/daemon.ts`.

## Context

ADR-126 mapped #3332's seven guarantees onto the WAL. Its fifth row, "A failed body write must not skip an event", was recorded as open, because `Wal.append` wrote the bodies first and a body write could throw before the event write.

ADR-127, accepted the same day, closed that row. The WAL caught a failed body write, reported it, and still appended the sealed event. The control plane would accept the event and record the missing content through its `body_missing` gap. ADR-127 also kept event reads strict, on the ground that skipping an event would conceal a broken chain.

#3822 (`035a1273d`, 2026-09-23) reversed both. The code gives two reasons:

- A swallowed body failure left the caller nothing to roll back once the event write succeeded. The event was on disk without its content, and the hook that carried the content had been answered, so nothing would send it again.
- A strict read threw on one torn line. Every reader of that event file threw with it, the shipper's walk of unshipped events included, so one crash mid-append stopped the daemon shipping every session on the host.

Neither ADR changed with the code. ADR-126 row 5 still reads as open, and ADR-127 describes a WAL this tree no longer has. Accepted ADRs are not edited (`docs/adr/README.md`), so this ADR records what the code does now. The two ADRs' status lines point here, as ADR-074's does to ADR-086.

## Decision

1. **A failed body write throws.** `Wal.writeBodies` reports the failure through the diagnostic sink with its session, operation, and error code, then rethrows the error. A sink that throws does not replace the original error. `Wal.append` writes bodies before events, so the throw leaves every event in the call unwritten. For a call whose bodies belong to one session, the WAL then holds neither the event nor its body. A call with bodies for several sessions can leave an earlier session's body lines behind (see Limits).
2. **The caller rolls back the seal.** These writers take a chain mark before they seal, and call `rollbackChain` or `rollbackEveryChain` when the append throws: the hook path, commands (`recordSealedAsync`), the gateway (`recordGatewayCall`), OTel ingest, the detector, the checkpoint, the idle sweep, the worktree reconciliation, the spool and restart telemetry gaps, and the transcript tailer. The recorder's cursor returns to the mark. A body the caller had already drained with `takeBodies` goes back to the recorder, because `ChainMark` carries the drained bodies as a list (`SessionRecorder.rollbackChain` in `packages/tacho/src/claude-code/recorder.ts`). On the hook path the daemon also restores the command queues and forgets the hook's id, so the client's spool replay of the same hook is not dropped as a repeat.
3. **Four writers do not roll back.** The SessionEnd terminal is journaled first and retried from the journal through `Wal.appendRecovered` (ADR-139), so its seal is kept, not undone. The daemon's genesis and shutdown seals on the host chain carry no body and take no mark. The model proxy (`packages/tacho/src/collector/model-proxy.ts`) seals its `llm_call` and `policy_decision` frames with no mark: a failed write is logged, the frame is lost, and the recorder's cursor stays one seq ahead of the WAL (see Limits).
4. **Guarantee 5 holds on the paths that roll back, and ADR-126 row 5 is closed.** On those paths a failed body write skips no event. When the spool replay or the retry succeeds, the event lands at the seq it would have had, with its body.
5. **A failed event write leaves no torn line.** `Wal.append` truncates the failing event file back to its size before the call when the event write throws part way. At startup the daemon calls `Wal.repairTail` on each session. A final line that parses gets its missing newline, and a line that does not parse is cut.
6. **Event reads skip a line that does not parse.** Both event readers report the line through `reportEventParseFailure` and go on: `Wal.read`, which `head`, `compact`, `lastSeqOf`, `appendRecovered`, and the retention sweep use, and `Wal.eventsAfterShipped`, which `unshipped` and `stats` use. `eventsAfterShipped` leaves its resume mark before the bad line, so each walk reads that line again and reports it again. This replaces "Event reads remain strict". A skipped line cannot pass for a whole chain: each event carries its predecessor's hash, and `verifyChain` requires a dense seq (`packages/tacho/src/chain.ts`).

ADR-127 keeps the rest of its decision. Each body batch starts with a newline, so a torn body line from an earlier attempt stays on its own line. Body reads skip malformed records and report them once per read. Retention rewrites remove torn body records. Diagnostics carry an error code, with no body bytes and no filesystem error message.

## Consequences

A failed body write now delays its event rather than recording it without content. The daemon answers the hook with an error, `tacho-hook` spools it, and the daemon replays the spool on later ticks. A disk too full to take the spool file loses the hook. ADR-127 lost it on that disk too, because its event write failed as well.

One bad event line costs that line, not the host's shipping. A line skipped in the middle of a file leaves the chain around it broken, so the loss shows in the record.

## Limits

These hold at `7dfcd0b95`. #4311 tracks all four.

- **A write across several sessions is not all or nothing.** When one `Wal.append` call writes events for two sessions and the second session's event write throws, the first session's event file keeps what the call wrote, and its `lastSeq` stays advanced. The caller rolls every marked chain back anyway, so that session's recorder ends up behind its WAL tail, and the seq guard refuses its next write. The checkpoint is the common caller that writes several sessions in one call.
- **A failed call can leave body lines behind.** Bodies for other sessions in the same call, and complete bodies written before an event write failed, stay on disk. The body index keeps the first line it sees for an event id, and the id comes from the session and seq. A different event later sealed at that rolled-back seq can then ship with the orphan body, and the control plane refuses it as `digest_mismatch`. #3372 also tracks the orphan-body half.
- **The model proxy does not roll back.** Decision 3 describes the gap its failed write leaves.
- **No test drives a real body-write failure through the daemon.** The daemon tests below replace `wal.append` with a function that throws, so `Wal.writeBodies` never throws inside the daemon. Decision 4 rests on the WAL test and the recorder test together.

## Evidence

In `packages/tacho/src/host/wal-body-failure.test.ts`:

- "throws and persists neither the event nor its body when the body path is unwritable"
- "keeps prior and later bodies readable around a partial append that throws, once retried"
- "surfaces the real body-write failure even when the diagnostic sink itself throws"
- "skips a torn event line and reports it, rather than throwing"

Beside the daemon and the recorder:

- `daemon.test.ts`, "seals the spool replay of a hook whose live write failed"
- `daemon-bodies.test.ts`, "reseals a gateway call whose WAL write failed with its body and no hole"
- `daemon-sweep.test.ts`, "seals one idle session when another's final write fails, and closes the other on the next sweep"
- `recorder-rollback.test.ts`, "puts back a body the failed caller had already drained"

All eight passed in the `test` job of push-to-main CI run 36174762763, on `5d00704a1`.
