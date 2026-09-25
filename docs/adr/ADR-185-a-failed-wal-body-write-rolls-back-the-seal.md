# ADR-185: A failed WAL body write rolls back the seal

Status: Accepted

Date: 2026-09-25

Supersedes: two decisions in ADR-127, "The WAL still attempts the sealed event append" and "Event reads remain strict"

Related: #3365, #3822, ADR-126, ADR-127, ADR-139

## Context

ADR-126 mapped #3332's seven guarantees onto the WAL. Its fifth row, "A failed body write must not skip an event", was recorded as open, because `Wal.append` wrote the bodies first and a body write could throw before the event write.

ADR-127, accepted the same day, closed that row. The WAL caught a failed body write, reported it, and still appended the sealed event. The control plane would accept the event and record the missing content through its `body_missing` gap. ADR-127 also kept event reads strict, on the ground that skipping an event would conceal a broken chain.

#3822 (`035a1273d`, 2026-09-23) reversed both. The code gives two reasons:

- A swallowed body failure left the caller nothing to roll back once the event write succeeded. The event was on disk without its content, and the hook that carried the content had been answered, so nothing would send it again.
- A strict read threw on one torn line. `unshipped`, `stats`, `head`, and `compact` all read through `Wal.read`, so one crash mid-append stopped the daemon shipping every session on the host.

Neither ADR changed with the code. ADR-126 row 5 still reads as open, and ADR-127 describes a WAL this tree no longer has. Accepted ADRs are not edited (`docs/adr/README.md`), so this ADR records what the code does now.

## Decision

1. **A failed body write throws.** `Wal.writeBodies` reports the failure through the diagnostic sink with its session, operation, and error code, then rethrows the error (`packages/tacho/src/host/wal.ts:263-291`). `Wal.append` writes bodies before events, so the throw leaves the event unwritten. The WAL holds neither the event nor its body. A sink that throws does not replace the original error.
2. **The caller rolls back the seal.** Every daemon path that seals and then appends takes a chain mark first, and calls `rollbackChain` or `rollbackEveryChain` when the append throws. The recorder's cursor returns to the mark. A body the caller had already drained with `takeBodies` goes back to the recorder, because `ChainMark` carries the drained bodies as a list (`packages/tacho/src/claude-code/recorder.ts:222`, `:723`). On the hook path the daemon also restores the command queues and forgets the hook's id, so the client's spool replay of the same hook is not dropped as a repeat (`packages/tacho/src/collector/daemon.ts:2312-2325`). The gateway path (`recordGatewayCall`) and the idle sweep each roll back one chain.
3. **Guarantee 5 holds, and ADR-126 row 5 is closed.** A failed body write skips no event. When the spool replay or the retry succeeds, the event lands at the seq it would have had, with its body.
4. **A failed event write leaves no torn line.** `Wal.append` truncates the event file back to its size before the call when the event write throws part way (`wal.ts:421`). At startup the daemon calls `repairTail` on each session. A final line that parses gets its missing newline, and a line that does not parse is cut.
5. **Event reads skip a line that does not parse.** `Wal.read` reports the line through `reportEventParseFailure` and goes on (`wal.ts:556`). This replaces "Event reads remain strict". A skipped line cannot pass for a whole chain: each event carries its predecessor's hash, and `verifyChain` requires a dense seq (`packages/tacho/src/chain.ts:82`).

ADR-127 keeps the rest of its decision. Each body batch starts with a newline, so a torn body line from an earlier attempt stays on its own line. Body reads skip malformed records and report them once per read. Retention rewrites remove torn body records. Diagnostics carry an error code, with no body bytes and no filesystem error message.

## Consequences

A failed body write now delays its event rather than recording it without content. The daemon answers the hook with an error, `tacho-hook` spools it, and the daemon replays the spool on later ticks. A disk too full to take the spool file loses the hook. ADR-127 lost it on that disk too, because its event write failed as well.

One bad event line costs that line, not the host's shipping. A line skipped in the middle of a file leaves the chain around it broken, so the loss shows in the record.

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
