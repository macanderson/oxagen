/**
 * The daemon's hook queues (#4601, ADR-231): one per harness session, and one
 * for the host.
 *
 * `tachod` used to run every hook from every session through one queue, so a
 * hook waited for every hook queued ahead of it whatever session sent it. A
 * prompt waiting 500 ms for its recalled memories held each other agent's
 * `PreToolUse` answer for those 500 ms.
 *
 * A session queue runs one session's work one task at a time, in the order it
 * arrived. The registry, the session's hash chain in the WAL, and its turn and
 * tool frames all assume that. Tasks in two different session queues run
 * concurrently: they interleave only at an `await`, and neither touches the
 * other's chain.
 *
 * The host queue runs work that must not interleave with any session's work.
 * A host task starts once every task queued before it, in every session queue,
 * has settled. Every task queued after it, in any queue, waits for it to
 * settle. Host tasks run one at a time, in arrival order.
 *
 * The key of a session queue is the raw harness session id, not the
 * agent-qualified registry key. Two agents that hand out the same raw id
 * share a queue, which costs them concurrency and nothing else. It keeps a
 * record that OTel or a transcript opened before any agent named itself in
 * the same queue as the hooks that later adopt it.
 *
 * A task must never await a task queued after it in a queue it waits on. A
 * host task that awaited a session task queued after it would wait forever,
 * and so would a session task that awaited a host task it queued. A session
 * task hands host work back by queueing it and returning the promise, which
 * its caller awaits once the session task has settled.
 */

/** Settles when `promise` settles, whichever way, and never rejects. */
function settled(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}

export class HookQueues {
  /** The last host task, settled either way. */
  private hostTail: Promise<void> = Promise.resolve();
  /** Whether a host task is running now. */
  private hostRunning = false;
  /** The last task queued for each session, settled either way. */
  private readonly tails = new Map<string, Promise<void>>();
  /**
   * Session tasks queued since the last host task, settled either way. The
   * next host task waits for each of them.
   */
  private sinceHost = new Set<Promise<void>>();
  /** The sessions with a task running now: started and not settled. */
  private readonly running = new Set<string>();

  /**
   * Queue `task` for one session. It starts once the session's previous task
   * and the last host task queued before it have settled.
   */
  session<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key);
    const ready =
      previous === undefined
        ? this.hostTail
        : settled(Promise.all([this.hostTail, previous]));
    const run = ready.then(() => this.track(key, task));
    const done = settled(run);
    this.tails.set(key, done);
    this.sinceHost.add(done);
    void done.then(() => {
      this.sinceHost.delete(done);
      if (this.tails.get(key) === done) this.tails.delete(key);
    });
    return run;
  }

  /**
   * Queue `task` for the host. It starts once every task queued before it
   * has settled, and every task queued after it waits for it.
   */
  host<T>(task: () => Promise<T>): Promise<T> {
    const ready = settled(Promise.all([this.hostTail, ...this.sinceHost]));
    const run = ready.then(async () => {
      this.hostRunning = true;
      try {
        return await task();
      } finally {
        this.hostRunning = false;
      }
    });
    this.hostTail = settled(run);
    this.sinceHost = new Set();
    return run;
  }

  /**
   * Whether this session's work may be running now: a task of its own, or a
   * host task, has started and not settled. A caller that seals on a
   * session's chain outside the queues (the sweep, the checkpoint) passes
   * over a session this answers true for, because a running task may stand
   * between its chain mark and its WAL write.
   */
  busy(key: string): boolean {
    return this.hostRunning || this.running.has(key);
  }

  /** Whether a host task is running now. */
  hostBusy(): boolean {
    return this.hostRunning;
  }

  /** Whether no task of any queue is running now. */
  idle(): boolean {
    return !this.hostRunning && this.running.size === 0;
  }

  private async track<T>(key: string, task: () => Promise<T>): Promise<T> {
    this.running.add(key);
    try {
      return await task();
    } finally {
      this.running.delete(key);
    }
  }
}
