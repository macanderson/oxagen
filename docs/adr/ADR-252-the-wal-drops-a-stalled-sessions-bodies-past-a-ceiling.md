# ADR-252: The WAL drops a stalled session's bodies past a ceiling

- **Status:** Accepted
- **Date:** 2026-10-02
- **Owners:** tacho
- **Related:** issue #3722, issue #3694 (the measured WAL), issue #3662 (ingest
  answers 503 under store pressure), ADR-139 (one store for a run's content on
  the host), ADR-231 (reads outside the hook queues), `docs/specs/tacho/spec.md`
  §3 (the WAL paragraphs), `docs/specs/tacho/data-model.md` §2.13.

Code references name the symbol. The ceiling is `WalCeiling` in
`packages/tacho/src/host/wal-ceiling.ts`. The WAL is `Wal` in
`packages/tacho/src/host/wal.ts`. The daemon is
`packages/tacho/src/collector/daemon.ts`, and the status command is
`packages/tacho/src/cli/status.ts`.

## Context

The WAL keeps each session's events in `<session>.ndjson` and the session's
content, the bodies, in `<session>.bodies.jsonl`. `Wal.compact` removes a
session only once three things hold: the session is sealed, every event has
shipped, and it is older than `walRetainMs`, which is seven days.

A session whose batches keep failing never ships. Its cursor never moves, so
`compact` never removes it, and its events and bodies stay for as long as the
failure lasts. No ceiling applied to either. The ingest route now answers 503
when the store is under pressure (#3662). The host keeps the batch and backs
off, which is right, and it makes a long refusal an ordinary condition rather
than an error.

The measurements set the scale. One heavy twelve-hour day on one machine
wrote 8.5 GB to the WAL, and 8.4 GB of it was bodies (#3694). A first start on
2026-10-02 imported old transcripts and put 1.0 GB in the WAL at once. An
outage of a few days on a heavy host fills a laptop disk. A full disk stops
the person's own work, not only the recording.

`MAX_BODY_AUTHORITY_WAIT_MS`, 24 hours, does not cover this. It bounds how
long the shipper holds back events whose retention mandate is unproven, which
is a different condition from a batch the control plane keeps refusing.

Every answer loses something. Dropping the oldest events breaks the chain and
loses evidence the chain says exists. Refusing to record loses the run and
keeps the machine working. Dropping bodies and keeping events loses content
and keeps the chain whole, which is what the retention classes already do on
purpose. The issue carried `needs:decision` and proposed the last answer.
This ADR takes it.

## Decision

### Stalled sessions

A session is **stalled** when it has events past its shipped cursor and the
cursor has not moved for one hour. The daemon checks once a minute. Each check
compares every waiting session's `shippedThrough` with what the last check
saw, and a session whose cursor moved starts its hour again.

The test is per session and not "nothing shipped on this host for an hour".
The case behind #3662 is a store that refuses most batches and accepts some,
so the host as a whole keeps shipping a little while the WAL grows. A
host-level test never fires there. A per-session test does, because the
shipper sends the latest session first, and the sessions it never reaches stop
moving.

A session that is shipping moves its cursor every few seconds, so it is never
stalled, however much it holds. That matters because the byte count is whole
files. A long healthy session can hold gigabytes of bodies that already
shipped, and nothing cheap says where its unshipped bodies start: the body
index maps event ids to offsets and does not record seqs.

The clock lives in the daemon's memory. A restarted daemon starts every clock
again, so it drops nothing for its first hour. At the measured rate that lets
the WAL pass the ceiling by under a gigabyte after a restart, and it keeps
`cursor.json` in the format every build reads.

### The ceiling

The ceiling is the smaller of two figures:

1. **8 GiB.** That is about one heavy working day, the 8.5 GB measured on
   #3694, so an outage shorter than a working day loses nothing. The 1.0 GB
   first-start import fits eight times over.
2. **Half the space the disk would have free without the stalled sessions.**
   A fixed figure alone cannot protect a disk with less free space than the
   figure. With this term, the stalled sessions never take more than half of
   the room they could use, and the other half stays for the person's work.
   The free space comes from `statfs` on the WAL directory. When that cannot
   be read, the fixed figure applies alone.

What counts against the ceiling is the size of every stalled session's event
file and body file. Sessions that are not stalled do not count. A sealed,
fully shipped session is `compact`'s to remove, under the seven-day retention,
and this ADR does not change that.

### What goes, and in what order

When the stalled sessions hold more than the ceiling, the session stalled
longest loses its body file first, then the next, until the total is back
under. Among sessions stalled equally long, the one whose last event is oldest
goes first, because the shipper reaches it last.

A drop removes the session's whole body file and its index. It does not
rewrite the file to keep part of it. A rewrite reads every line on the
daemon's only thread, and a session over the ceiling can hold gigabytes, which
ADR-231 rules out. The removal also takes the local copies of bodies that had
already shipped. The control plane holds those, so only `tacho export` and
incident review on this host lose them.

Events are never dropped by the ceiling. They are about one percent of the
bytes (0.1 GB of the 8.5 GB measured), and they are the chain. The chain
commits to each body by digest in its event, and the bytes live in the
separate body file, so removing the file leaves every hash and every link as
it was. Each event still ships. The control plane records a `body_missing` gap
for each frame that owed a body, which is what a lost body has always meant.
If the events of stalled sessions alone ever pass the ceiling, the WAL keeps
them and `oxagen agent status` says it is over.

Content under the ceiling is kept however old it is. It can still ship once
the control plane accepts it again, and dropping it would destroy evidence for
no disk gain. The one hour of stall is the only age in the rule.

### The record of a drop

Each drop seals a `telemetry_gap` frame with a new cause, `wal_ceiling`, on
the daemon's own chain. `incident_evidence` names the session, the bytes
removed, the last event the control plane holds with its body
(`shipped_through`), the last event on disk (`last_seq`), when the session
stalled, what the stalled sessions held, and the ceiling in force.
`gap_duration_ms` is how long the session went without shipping.
`gap_dropped_count` stays unset, because no cheap count of the removed bodies
exists and the bytes are the honest measure. `incident_kind` stays unset, so
no incident row is written.

The frame goes on the daemon's chain and not the session's. A stalled session
has often sealed its `agent_stop` already, or left the registry, and a frame
after the stop is one the recorder has to stamp as late. The daemon's chain
always takes a frame. The session's own record still shows the loss, as its
`body_missing` gaps.

The daemon seals the frame in the same synchronous stretch as the removal, so
nothing else runs between them. If the frame cannot be written, the daemon logs
it and the drop stands. The disk is close to full when this runs, and the
removal is what frees the room the write needs.

`GAP_CAUSES` is a `z.enum` in the ingest schema, so `wal_ceiling` is a change
to the wire. The control plane deploys from `main` before `publish-installers`
builds the installers from the same commit, so no shipped host sends a cause
production refuses.
ClickHouse stores `gap_cause` as `LowCardinality(String)`, so no migration is
needed.

### Where it runs

The check is a stage of the daemon's tick, after the drain, so a session that
just shipped has moved its cursor first. It stats each waiting session's two
files and removes whole files. It reads no body, and no event past the last
line the WAL already keeps for each session, so it does not hold the thread on
a large file. It runs on no hook queue. It skips a tick while a task
that can seal on the daemon's chain is running, the way the sweep and the
checkpoint skip a busy session, because such a task can stand between a chain
mark and its WAL write.

### What a person sees

The daemon keeps what the last check saw in `wal/ceiling.json`: the ceiling,
what the stalled sessions hold, how many there are, and the drops of the last
`walRetainMs`, up to twenty. It writes the file only when one of those
changes, and a host where nothing stalled has no file. `oxagen agent status`
reads the file, so it works while the daemon is down. It prints what the
stalled sessions hold against the ceiling, says OVER when they hold more, and
names each session whose content went, with the bytes and the events that
ship without their bodies. `--json` carries the same under `wal.ceiling`. The
daemon's health report, which is a wire type, is unchanged.

## Consequences

- A control-plane outage can no longer fill the disk with bodies. The WAL
  holds at most the ceiling for stalled sessions, plus their events, plus
  what `compact` already keeps for shipped sessions.
- A backlog larger than the ceiling that does not move for an hour loses its
  oldest sessions' content, whatever the cause. That includes a healthy
  drain of a very large import, because the shipper sends the latest session
  first and an old imported session can wait an hour for its turn. The
  measured import was 1.0 GB, an eighth of the ceiling.
- A drop is not reversible. The control plane never had the content of the
  events past `shipped_through`, and the host no longer has it.
- The seven-day window for `tacho export` and incident review shrinks for a
  session that was dropped, because its local copies of shipped bodies go too.
- A journaled terminal batch that retries after a drop writes its own few
  bodies again, because `appendRecovered` finds no stored body to skip.
- `Shipper` still calls `Wal.dropBodies` on the drain path when a proven
  mandate withdraws a class, and that rewrite reads the whole body file on the
  daemon's thread. This ADR does not change it. It runs only on a narrowing,
  not on every drain.

## Alternatives considered

- **A host-level stall test (nothing shipped on the host for an hour).**
  Simpler, and it misses the case behind #3662: a store that accepts some
  batches keeps the host "shipping" while the WAL grows.
- **Counting every session with an unshipped event.** Whole-file counts would
  put a healthy long session's shipped bodies against the ceiling, and a host
  with two long live sessions would drop content that was about to ship.
- **Dropping only the oldest bodies, by rewriting the file.** It keeps more
  content, and it costs a read of the whole file on the daemon's thread, which
  ADR-231 rules out. An off-thread copy is possible, and it is a larger change
  for a session that is already past the ceiling.
- **Dropping events as well, oldest first.** It breaks the chain, and events
  are one percent of the bytes.
- **An age ceiling (drop anything stalled for seven days).** It frees no disk
  the byte ceiling would not, and it destroys content that could still ship.
- **Refusing to record past the ceiling.** It loses whole runs to keep a few
  gigabytes, and the record would show nothing at all for them.
- **Sealing the frame on the stalled session's own chain.** The run page
  would show the cause in place, but most stalled sessions are sealed or
  forgotten, and a frame after `agent_stop` is one the recorder stamps as
  late. One rule, on the daemon's chain, always holds.
- **A new frame kind.** `telemetry_gap` already means "the daemon reports a
  gap in what it recorded", and a new cause says which gap.
