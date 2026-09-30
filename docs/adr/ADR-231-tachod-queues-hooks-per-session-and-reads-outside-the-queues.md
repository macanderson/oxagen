# ADR-231: tachod queues hooks per session and reads outside the queues

- **Status:** Accepted
- **Date:** 2026-09-30
- **Owners:** tacho
- **Amends:** ADR-190 (its Limits section), the #4299 rule on
  `Wal.bodiesForAsync`
- **Related:** issue #4601, issue #4394, issue #4361, issue #4366 (item 3),
  ADR-139, ADR-189, `docs/specs/tacho/spec.md` §3.2.

Code references name the symbol. The queues are `HookQueues` in
`packages/tacho/src/collector/hook-queues.ts`, the daemon is
`packages/tacho/src/collector/daemon.ts`, the tailer is
`packages/tacho/src/collector/transcript-tailer.ts`, and the git lane is
`packages/tacho/src/collector/git-lane.ts`.

## Context

`tachod` ran every hook from every wrapped agent on the host through one
queue. A hook waited for every hook queued ahead of it, whatever session sent
it, and so did the work the tick put on the same queue.

1. **A slow hook held every agent (#4601).** A prompt waits up to 500 ms for
   the memories the control plane recalls for it. While it waited, every other
   session's `PreToolUse` answer waited too. Ten agents prompting at once could
   add five seconds to the last one's tool call.
2. **A transcript backfill held every hook (#4394).** The tick tailed every
   transcript the registry held, inside the queue, a bounded read per file but
   no bound across files. On a new install with a long history, one host
   logged 305 hooks: 27 took over three seconds, the slowest took 10,404 ms,
   and a `SessionStart` timed out and failed open.
3. **A body index build held every hook (#4361).** A journaled SessionEnd's
   flush builds the body index of a body file with no sidecar, with awaited
   reads (#4299). It did so inside the queue, about 0.8 seconds per GB.
4. **`stop` could exit before the host chain's `agent_stop` landed (#4366).**
   `stop` sealed the host chain behind the task running on the queue. A push
   hook reads the repository's remotes, up to ten seconds for each git
   command, and the process exits at `STOP_GRACE_MS`, five seconds.

The one queue also carried an invariant nothing else did: one session's hooks
run one at a time, in the order they arrived. The registry, the session's
hash chain in the WAL, and its turn and tool frames all rely on that. A hook
marks its chain, seals frames, awaits, and writes them. Anything that seals on
that chain in between is rolled back with it if the write fails.

## Decision

1. **One queue per session, and one for the host.** `HookQueues` runs one
   session's tasks one at a time, in arrival order, and two sessions' tasks
   concurrently. The key is the raw harness session id, so a record that OTel
   or a transcript opened before an agent named itself shares a queue with the
   hooks that later adopt it. A host task starts once every task queued before
   it, in every queue, has settled, and every task queued after it waits for
   it.
2. **What runs where.**
   - A session's queue: its live hooks (listener and contained runner), the
     OTLP records that name it (one task per session a post names), the
     tailer's seals of its transcripts, the gateway frame of a call it waits on
     (ADR-189), and the git lane's facts and reconciliation for it.
   - The host queue: the spool drain, a journaled SessionEnd's seal and flush
     (`settleEnding`), the state file a deferred SessionEnd writes before it is
     answered, the state file the tick writes when hooks kept it waiting past
     five seconds, the gateway frame of a call no session has met yet
     (ADR-189 decision 7), and `stop`'s seal of the host chain.
   - The gateway frame of a call no session has met waits for the
     `PreToolUse` that will claim it, and nothing names that hook's session
     before it is handled. The host queue runs the frame after every task
     queued before it, the hook's live request among them, and lets it drain
     the spool, where the hook sits after a restart. Remembering the session
     each unhandled `PreToolUse` names would put the frame on that session's
     queue, but the spooled hook would still need the host queue, so the map
     would add state and remove no path.
   - Neither: the sweep and the checkpoint seal in one synchronous stretch and
     pass over a session whose queue is running a task, and every session
     while a host task runs. The tick writes the state file itself when no
     task is running. The host chain's other writers (the gateway, the model
     proxy, run tokens) are synchronous. The detector and the operator's
     commands stay where they were, off every queue.
3. **A hook marks and rolls back only its own queue's chains.**
   `recordHookOutcome` marks the chains and message queues of the records
   that share its raw session id, and a failed write rolls back those alone.
   A rollback that reached another session would take its chain behind frames
   the WAL already holds.
4. **A hook drains the spool only for its own session.** A live hook whose
   session has a hook in the spool waits for a drain on the host queue first,
   so the spooled hooks reach its chain ahead of it. A hook whose session has
   none goes straight to its queue. The tick drains the rest.
5. **The tailer reads outside the queues (#4394, option 1).** The tick reads a
   transcript's bytes on no queue and takes the session's queue only to seal
   what it read, in slices of at most 256 KiB with a turn of the event loop
   between them. Each slice checks, inside the queue, that the cursor still
   stands where the read began, because a `Stop` in the queue can drain the
   transcript while the tick reads. A tick reads at most 4 MiB from a file and
   at most 16 MiB in all, subagent transcripts included, and it starts no file
   once less than 4 MiB of that is left. The next tick starts with the session
   and the file this one could not start. `Stop` and `SessionEnd` drain
   their transcript inside their own session's queue, which holds no other
   session. The daemon never skips transcripts older than the enrollment
   (#4394, option 3): the record keeps what the host holds.
6. **A journaled SessionEnd builds its body indexes before it takes the host
   queue (#4361, finding 1).** `settleEnding` builds the indexes of the ending
   session's body file and its open subagents' first, on no queue, then seals
   and flushes on the host queue, where the flush finds each index covering
   its file. Every journaled flush goes through `settleEnding`: for a
   SessionEnd a live hook deferred, one a spool replay deferred, and one
   journaled before a restart. A SessionEnd sealed straight from its hook
   writes through `Wal.append`, which consults no index.
7. **`bodiesForAsync` falls back to the synchronous read as a last resort
   (#4361, finding 2, option a).** An index stale on both awaited attempts is
   answered by `bodiesFor` with no `stale` set, which rebuilds the index on the
   event loop and reads the bodies. `body_index_unusable` is reported only
   when that read also finds its index disagreeing with the file. The #4299
   rule now reads: `bodiesForAsync` never rebuilds a body index synchronously,
   except as a last resort.
8. **`stop` abandons the git reads hooks make (#4366, item 3).** From the
   moment `stop` begins, a push hook's credential basis read and a session's
   remote read answer at once with no status. The running hooks finish in the
   time their own work takes, and `stop` seals the host chain on the host
   queue inside `STOP_GRACE_MS`. The git lane's reads are not abandoned: `stop`
   waits for them no longer than `stopLaneMs`.

## Consequences

- A slow hook holds its own session. Another session's `PreToolUse` is
  answered while a prompt waits on its recall.
- A transcript backfill holds no hook. A session's hooks wait on the tick's
  seals of that session's transcript, one slice at a time.
- A body index build holds no hook. ADR-190's Limits line saying hooks wait
  behind the build is removed.
- A host task still waits for every running hook. The host queue carries work
  that happens once per session end, once per spooled backlog, once per
  gateway call no session has met, and at `stop`. A gateway call from a
  hooked session is met by its `PreToolUse` first, so only a call whose hook
  was spooled, or one from a session without hooks, takes the host queue.
  The state file is written through it only after five seconds of hooks
  running without a pause, so under that load a hook can wait once every five
  seconds for the slowest hook running then.
- Stored content is not lost on the stale-twice path. That path needs a body
  file rewritten in place, at the same size, while each awaited build reads
  it. The daemon never does that, since its rewrites go through a temp file
  and a rename, so the synchronous rebuild costs a one-off stall on a path that
  needs outside tampering.
- A hook's git read that `stop` abandoned records the push as `harness_held`,
  which is what any failed read records.

## Limits

- The detector and the operator's commands (`onControl`) still mark every
  chain and seal across awaits on no queue, as they did beside the one queue.
  A write that fails there rolls back every chain it marked, a hook's among
  them.
- The first state write at `stop`, before its waits, can still catch a hook
  between its seal and its write, as it could catch the one running task
  before. The host queue's seal writes the state file again once the running
  hooks settle.
- On macOS, the first live hook that names a new pid still reads its start
  time with a synchronous `ps` (#4366, item 2), which holds the event loop and
  so every queue.

## Alternatives

- **Keep one queue and shorten the recall wait.** The wait is 500 ms
  (`MEMORY_RECALL_TIMEOUT_MS`). Any wait on the one queue is paid by every
  agent on the host, so a shorter one bounds the cost and does not remove it.
- **Put every host-wide step on the host queue, the state file on every
  tick included.** Simple, and the one queue's guarantee for each. A host task
  waits for every running hook, so a barrier every second puts a prompt's
  recall back in front of other agents' tool calls about half the time.
- **Cap the tailer per tick and keep it in the queue (#4394, option 2).** It
  bounds the stall and keeps it. Reading outside the queue removes it, and the
  cap is kept as well to bound the tick itself.
- **Keep a stale-twice batch for the next drain (#4361, option b).** One bad
  body file would hold the shipper back for every session behind it.
- **Close the stale-twice finding as unreachable (#4361, option c).** The
  cost of being wrong is content lost for good, and the synchronous read that
  guards it costs nothing on any path the daemon reaches.

## Evidence

- `packages/tacho/src/collector/hook-queues.test.ts`: the ordering rules.
- `packages/tacho/src/collector/daemon-hook-queues.test.ts`, "answers session
  B's PreToolUse while session A's prompt waits on its recall" and "runs one
  session's hooks in the order they arrived".
- `packages/tacho/src/collector/daemon-transcript-backfill.test.ts`, "answers
  every hook within a second while a tick backfills old transcripts".
- `packages/tacho/src/collector/daemon-terminal-index.test.ts`, "answers a
  hook while the index is still being built".
- `packages/tacho/src/host/wal-index.test.ts`, "ships the bodies when the
  index is stale on both awaited attempts".
- `packages/tacho/src/collector/daemon-git.test.ts`, "seals the host chain
  inside its budget while a hook holds the queue".
- `packages/tacho/src/collector/daemon-bodies.test.ts`, "seals one tool_call
  on the session's chain for a gateway call whose PreToolUse was spooled": the
  frame of a call no session has met waits on the host queue behind the
  hook's live request, and lands on neither chain until the hook runs.
