/**
 * Writing frames to one chain from outside a hook (#4311, ADR-231).
 *
 * A seal moves a recorder's cursor in memory, and the WAL write after it is
 * what puts the frame on disk. A writer that seals and then fails to write
 * must take the chain back, or its next frame seals one seq past a WAL tail
 * that never held the first, and the control plane refuses the chain from
 * that gap on. `recordOnChain` marks the one chain it seals on and takes back
 * only that chain.
 *
 * A session's chain is also written by that session's hooks, on the
 * session's queue (`HookQueues`). A hook can seal, await, and write later, so
 * a frame sealed off the queue can land between a hook's seal and its write.
 * The hook's write is then refused, and its rollback leaves the chain behind
 * the WAL. `onSessionQueue` runs a seal on the session's queue instead. The
 * daemon's own chain has no queue: every writer seals and writes it in one
 * synchronous stretch.
 */
import type { SessionRecorder } from "../claude-code/recorder";
import type { TachoEvent } from "../envelope";
import type { FrameBody } from "../evidence/frame-body";

/** The daemon's `record`: sealed events, and their bodies, to the WAL. */
export type RecordSink = (
  events: readonly TachoEvent[],
  bodies?: readonly FrameBody[],
) => void;

/**
 * Run `apply` on a session's queue, after the work queued before it. The
 * daemon's runs it with `HookQueues.session`, keyed by the raw harness
 * session id.
 */
export type SessionExclusive = <T>(
  session: { readonly harnessSessionId: string },
  apply: () => T,
) => Promise<T>;

/**
 * Seal on one chain and write what was sealed, in one synchronous stretch.
 * The chain is marked before `seal` runs. When the seal or the write throws,
 * that chain goes back to the mark and the error goes on. The bodies the seal
 * queued are taken in the same call as its events, so a body is written next
 * to its event.
 */
export function recordOnChain(
  chain: SessionRecorder,
  seal: (chain: SessionRecorder) => readonly TachoEvent[],
  record: RecordSink,
): readonly TachoEvent[] {
  return recordOutcomeOnChain(
    chain,
    (sealing) => ({ events: seal(sealing) }),
    record,
  ).events;
}

/**
 * `recordOnChain` for a seal that decides more than its frames, such as an
 * operator command's acknowledgement. `seal` returns its events with what it
 * decided, and that comes back once the events are written.
 */
export function recordOutcomeOnChain<
  T extends { readonly events: readonly TachoEvent[] },
>(
  chain: SessionRecorder,
  seal: (chain: SessionRecorder) => T,
  record: RecordSink,
): T {
  const mark = chain.markChain();
  try {
    const outcome = seal(chain);
    record(outcome.events, chain.takeBodies());
    return outcome;
  } catch (error) {
    chain.rollbackChain(mark);
    throw error;
  }
}

/**
 * Run `apply` on the session's queue when the caller has one, and right away
 * when it does not. A module built without the daemon's queues, as in a unit
 * test, keeps the timing it had before the queue existed.
 */
export function onSessionQueue<T>(
  exclusive: SessionExclusive | undefined,
  session: { readonly harnessSessionId: string },
  apply: () => T,
): Promise<T> {
  if (exclusive !== undefined) return exclusive(session, apply);
  // The executor runs `apply` now, and a throw rejects the promise.
  return new Promise<T>((resolve) => resolve(apply()));
}
