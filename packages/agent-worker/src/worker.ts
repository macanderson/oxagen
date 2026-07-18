/**
 * The durable-run worker harness (agent-engine v2 Phase 2c —
 * docs/specs/agent-engine-v2/plan.md "Phase 2 — Durable runs").
 *
 * A worker process runs `concurrency` independent claim loops. Each loop
 * claims one run at a time (`FOR UPDATE SKIP LOCKED` server-side — Inngest
 * keeps dispatch/cancel/sweep; this harness only claims, drives, and
 * terminates), drives it to completion via the injected `TurnDriver` in
 * ordinary process memory, and only then claims again — a "slot" is free
 * again exactly when its current run reaches a terminal decision.
 *
 * Per claimed run, two unref'd interval tickers run alongside the driver:
 *   - lease renewal, so a slow run's row isn't reclaimed out from under it;
 *   - cancel polling, so a user cancel request reaches the driver's
 *     AbortSignal without the driver needing to poll anything itself.
 * Either a lost lease (`renewLease`/`saveCheckpoint` returning `false`) or a
 * cancel request aborts the same signal — the driver never needs to know
 * which. Lease loss additionally stops ALL further store writes for that run
 * (the other claimant owns the row now); see `decideTerminalAction`.
 *
 * Events are buffered client-side with a monotonic seq (`SeqCounter`,
 * continuing from `checkpointSeq + 1` on resume) and flushed via
 * `appendEvents` only at two points: right before every `saveCheckpoint`, and
 * once more after the driver settles, before the terminal store call. This
 * is safe to replay after a crash because `appendEvents` is idempotent
 * server-side (`ON CONFLICT DO NOTHING` on `(run_id, seq)`); the worker never
 * needs its own dedup bookkeeping.
 */
import { hostname } from "node:os";
import { computeBackoffDelayMs } from "./backoff";
import { firstSeqForRun, SeqCounter } from "./seq";
import { decideTerminalAction } from "./terminal";
import type {
  AgentWorker,
  ClaimedRun,
  RunEventRecord,
  RunStore,
  TurnDriver,
  WorkerErrorHandler,
  WorkerOptions,
} from "./types";

export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_POLL_INTERVAL_MS = 2000;
/** Idle-poll backoff ceiling. Fixed — not derived from pollIntervalMs. */
export const DEFAULT_POLL_BACKOFF_CAP_MS = 15_000;
/** Lease is 600s server-side; renewing at 240s leaves slack for a missed tick. */
export const DEFAULT_LEASE_RENEW_INTERVAL_MS = 240_000;
export const DEFAULT_CANCEL_POLL_INTERVAL_MS = 5000;

/** `${hostname}:${pid}` — stable per process, unique enough per host to debug claimed-by. */
export function defaultWorkerId(): string {
  return `${hostname()}:${process.pid}`;
}

/**
 * Unref'd interval ticker: invokes `tick` every `intervalMs` until `stop()` is
 * called. A rejected tick is reported via `onError` and swallowed — a missed
 * tick (transient store error) must never crash the worker or fail the run;
 * the tick's own logic decides what a *resolved* `false` means. Mirrors
 * `packages/inngest-functions/src/lease.ts`'s `startLeaseRenewal` shape,
 * generalized to also drive cancel polling.
 */
function startTicker(
  tick: () => Promise<void>,
  intervalMs: number,
  onError: (err: unknown) => void,
): () => void {
  const timer = setInterval(() => {
    tick().catch((err: unknown) => onError(err));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** An unref'd, cancelable delay — cancel() resolves it immediately (used by graceful stop()). */
function interruptibleSleep(ms: number): {
  promise: Promise<void>;
  cancel: () => void;
} {
  let cancel!: () => void;
  const promise = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    cancel = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return { promise, cancel };
}

export function createAgentWorker(opts: WorkerOptions): AgentWorker {
  const store: RunStore = opts.store;
  const driveTurn: TurnDriver = opts.driveTurn;
  const workerId = opts.workerId ?? defaultWorkerId();
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const leaseRenewIntervalMs =
    opts.leaseRenewIntervalMs ?? DEFAULT_LEASE_RENEW_INTERVAL_MS;
  const cancelPollIntervalMs =
    opts.cancelPollIntervalMs ?? DEFAULT_CANCEL_POLL_INTERVAL_MS;
  const onError: WorkerErrorHandler | undefined = opts.onError;

  function reportError(
    err: unknown,
    ctx: { runId?: string; phase: string },
  ): void {
    if (!onError) return;
    try {
      onError(err, ctx);
    } catch {
      // The sink's contract is "never throws"; guard anyway so a misbehaving
      // caller-supplied handler can never take the worker down.
    }
  }

  let stopped = false;
  const activeSleepCancels = new Set<() => void>();
  const activeCancelPollStops = new Set<() => void>();

  /** Drives one claimed run to a terminal decision. Never throws. */
  async function driveOneRun(claimed: ClaimedRun): Promise<void> {
    const controller = new AbortController();
    let leaseLost = false;
    let cancelled = false;
    const seqCounter = new SeqCounter(firstSeqForRun(claimed));
    let pending: RunEventRecord[] = [];
    let lastFlushedSeq = claimed.checkpointSeq;

    async function flush(): Promise<void> {
      if (pending.length === 0 || leaseLost) return;
      const batch = pending;
      pending = [];
      try {
        await store.appendEvents(
          claimed.runId,
          claimed.orgId,
          claimed.workspaceId,
          batch,
        );
        lastFlushedSeq = batch[batch.length - 1]!.seq;
      } catch (err) {
        // Put the batch back so the next flush attempt (next checkpoint, or
        // the final completion flush) retries it instead of losing it.
        pending = [...batch, ...pending];
        throw err;
      }
    }

    function onEvent(type: string, payload: unknown): void {
      if (leaseLost) return; // the other claimant owns this run now
      pending.push({ seq: seqCounter.assign(), type, payload });
    }

    async function checkpoint(state: unknown): Promise<void> {
      if (leaseLost) return;
      await flush();
      const ok = await store.saveCheckpoint(
        claimed.runId,
        workerId,
        lastFlushedSeq,
        state,
      );
      if (!ok) {
        leaseLost = true;
        controller.abort();
      }
    }

    const stopLeaseTicker = startTicker(
      async () => {
        if (leaseLost) return;
        const ok = await store.renewLease(claimed.runId, workerId);
        if (!ok) {
          leaseLost = true;
          controller.abort();
        }
      },
      leaseRenewIntervalMs,
      (err) => reportError(err, { runId: claimed.runId, phase: "lease-renew" }),
    );

    const stopCancelTicker = startTicker(
      async () => {
        if (leaseLost || cancelled) return;
        const requested = await store.isCancelRequested(claimed.runId);
        if (requested) {
          cancelled = true;
          controller.abort();
        }
      },
      cancelPollIntervalMs,
      (err) => reportError(err, { runId: claimed.runId, phase: "cancel-poll" }),
    );
    activeCancelPollStops.add(stopCancelTicker);

    let driverError: { error: unknown } | null = null;
    let result: unknown;
    try {
      const outcome = await driveTurn(claimed, {
        onEvent,
        checkpoint,
        signal: controller.signal,
      });
      result = outcome.result;
    } catch (err) {
      driverError = { error: err };
    } finally {
      stopCancelTicker();
      activeCancelPollStops.delete(stopCancelTicker);
    }

    // Final flush before the terminal call — unless the lease is already
    // gone, in which case no further store write for this run is allowed.
    if (!leaseLost) {
      try {
        await flush();
      } catch (err) {
        reportError(err, { runId: claimed.runId, phase: "final-flush" });
        if (driverError === null) driverError = { error: err };
      }
    }

    const decision = decideTerminalAction({
      leaseLost,
      cancelled,
      driverError,
      result,
    });
    try {
      switch (decision.kind) {
        case "none":
          break;
        case "cancel":
          await store.cancelRun(claimed.runId, workerId);
          break;
        case "fail":
          await store.failRun(claimed.runId, workerId, decision.message);
          break;
        case "complete":
          await store.completeRun(claimed.runId, workerId, decision.result);
          break;
      }
    } catch (err) {
      // Terminal calls tolerate a resolved `false` (lost race) without
      // throwing per the RunStore contract; a *rejected* terminal call is a
      // real store failure — report it, but there is nothing left to retry
      // onto (the run already reached its decision).
      reportError(err, { runId: claimed.runId, phase: "terminal" });
    } finally {
      // Keep the lease alive through the terminal write, then release it.
      stopLeaseTicker();
    }
  }

  async function claimLoop(): Promise<void> {
    let attempt = 0;
    while (!stopped) {
      let claimed: ClaimedRun | null = null;
      try {
        claimed = await store.claimNextRun(workerId);
      } catch (err) {
        reportError(err, { phase: "claim" });
      }

      if (claimed) {
        attempt = 0; // busy queue: reset backoff on every successful claim
        await driveOneRun(claimed);
        continue;
      }

      if (stopped) break; // don't sleep on the way out
      // attempt=0 on the first empty claim (bound = base), doubling on each
      // consecutive empty claim thereafter, capped by DEFAULT_POLL_BACKOFF_CAP_MS.
      const delayMs = computeBackoffDelayMs(attempt, {
        baseMs: pollIntervalMs,
        capMs: DEFAULT_POLL_BACKOFF_CAP_MS,
      });
      attempt += 1;
      const { promise, cancel } = interruptibleSleep(delayMs);
      activeSleepCancels.add(cancel);
      try {
        await promise;
      } finally {
        activeSleepCancels.delete(cancel);
      }
    }
  }

  let loopPromises: Promise<void>[] = [];

  return {
    start(): void {
      stopped = false;
      loopPromises = Array.from({ length: concurrency }, () => claimLoop());
    },
    async stop(): Promise<void> {
      stopped = true;
      // Stop claiming (the flag above) and stop cancel-polling ticks — a
      // graceful shutdown aborts nothing; in-flight runs finish on their own
      // and their lease renewal keeps running until each does.
      for (const cancel of [...activeSleepCancels]) cancel();
      for (const stopFn of [...activeCancelPollStops]) stopFn();
      activeCancelPollStops.clear();
      await Promise.all(loopPromises);
    },
  };
}
