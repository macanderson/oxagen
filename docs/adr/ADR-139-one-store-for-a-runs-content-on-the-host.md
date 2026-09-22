# ADR-139: One store for a run's content on the host

Status: Accepted

Date: 2026-09-22

Related: #3365, #3332, #3342, ADR-100, ADR-126, ADR-127

## Context

A Tacho host holds a run's content, the prompt, the tool input and result, and
the assistant message, until the control plane accepts it. How many places may
hold it was left open. #3365 asked the question for the two pipelines in front
of it, the WAL body files from #3342 and the per-event `BodyStore` from #3332.
ADR-126 kept the WAL and the `BodyStore` is absent from the tree. The general
question stayed open, and the tree still answers it with two.

The first is the WAL body file, `wal/<session>.bodies.jsonl`, written by
`Wal.append` (`packages/tacho/src/host/wal.ts`). Every mechanism that reaches a
run's content reaches it here. `dropBodies` withdraws a batch's bodies,
`purgeBodiesOutsideMandate` sweeps a narrowed mandate through every session,
`compact` removes an aged sealed session with its bodies and its index sidecar,
and `tacho unenroll --purge` deletes the directory
(`packages/tacho/src/cli/unenroll.ts:526`).

The second is the daemon's terminal journal, `pending-session-ends.json`,
written by `persistPendingEnds` (`packages/tacho/src/collector/daemon.ts:1266`).
Its schema (`daemon.ts:1196`) carries `bodies[].bytes_base64`: the sealed
batch's content, in full, in a file no reader of the first path knows about.
`purgeBodiesOutsideMandate` and `compact` walk `wal/`. `tacho export` reads
`wal.read`. `tacho status` counts WAL events. `tacho unenroll --purge` removes
the WAL, the spool, the quarantine, and the collector log, and leaves this file
where it is. An operator who purges the host's record keeps the content of the
last sealed batch of every session that was ending.

The two paths also disagreed about what was already stored. `appendRecovered`
deduplicated the journal's events against the session's chain and wrote the
journal's bodies again every time. A terminal batch is flushed by the first
`SessionEnd`, by a second `SessionEnd` on the same chain (`daemon.ts:1581`), and
by a restart that read the journal entry before anything cleared it. Measured on
a scratch WAL: three flushes of one terminal batch left three copies of its
body, and a fourth retry left four.

## Decision

The WAL body file is the one store for a run's content on a host. Every other
place the content passes through is a hand-off: it is bounded, it is retried,
and it does not decide what the host holds.

`Wal.appendRecovered` does not write a body the session's body file already
stores. Identity is the event id, which is what `bodiesFor` reads a body back by
and what the retention sweeps name one by. The check reads `BodyIndexStore`, the
sidecar index that already holds one entry per stored body and extends rather
than rebuilds as the file grows, so it costs the lines appended since the last
read rather than a scan.

`TachoPaths.pendingEnds` names the terminal journal, so the file has one name
every surface can reach and `tacho unenroll --purge` can delete it with the WAL
rather than leaving it under a path only the daemon builds.

Three alternatives were rejected.

Retiring the WAL for a per-event store, option (a) of #3365, was rejected by
ADR-126 and is not reopened here. Nothing has changed about that trade, and the
`BodyStore` code is gone.

Leaving the journal holding bytes and teaching each sweep to walk it was
rejected. It gives the host two formats and two gates on one body, which is the
hazard #3365 was opened about. A body one gate refuses and the other allows
would still reach the wire through the permissive path.

Deduplicating in the daemon before it calls the WAL was rejected. The daemon
would have to know which bodies the body file holds, which is the WAL's own
index, read through a second caller that can fall out of step with it.

## Content already stored

Nothing has to be migrated and nothing has to be run on an enrolled host.

Duplicate body lines that earlier retries wrote are read correctly: the index
takes the first line for an event id, which is what a top-to-bottom read
answered with, so `bodiesFor` returns one body per event. `dropBodies` and
`purgeBodiesOutsideMandate` cut every copy, because they filter the file line by
line rather than by index. The retry that produced them writes no more.

A journal written by the previous version still flushes. Its entries carry
`bytes_base64`, `appendRecovered` takes bodies as before, and it writes the ones
the store does not already hold. A host that crashed mid-flush before the
upgrade lands its batch once after it.

A `pending-session-ends.json` that survived an earlier `tacho unenroll --purge`
is out of reach, because the enrollment it belonged to is gone. Delete the file,
or `~/.config/oxagen/tacho`.

## Consequences

`appendRecovered` costs one index read per session in a recovered batch. That
path runs on a flushed terminal batch and nothing else.

An index that cannot be built answers with nothing, so the body is written
twice rather than lost. A duplicate is swept; a missing body is a `body_missing`
gap on a frame that carried content.

The journal still holds bytes for the moment between sealing a terminal batch
and landing it. That window is one batch per session and it clears on flush, and
naming the file in `TachoPaths` is what makes it purgeable. Making the journal
carry references instead of bytes needs the bodies staged in the WAL before
their events, and `purgeBodiesOutsideMandate` reads a body whose event is not on
the chain as a crash orphan and deletes it. Staging is therefore a separate
change to the sweep and the daemon, not a rename.

Two call sites follow this decision and are sequenced separately, because they
sit outside `packages/tacho/src/host/`: `daemon.ts` reads `paths.pendingEnds`
instead of building the path itself, and `unenroll.ts` adds `paths.pendingEnds`
to what `--purge` removes.
