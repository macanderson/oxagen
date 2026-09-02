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
 *
 * The buffer has NO size or age cap, so both flush points are the driver's to
 * schedule. That matters for the driver actually shipped: `@oxagen/agent`'s
 * `createPlatformTurnDriver` never calls `io.checkpoint`, and it forwards every
 * engine stream part as its own event — so a long turn holds its entire event
 * log in memory until the turn settles, and a crash before that single flush
 * loses all of it. Capping the buffer (flush on N events or T ms) is the fix;
 * it is not implemented here.
 *
 * ── V2: fenced immutable attempts (docs/specs/run-evidence-ingress/spec.md) ──
 *
 * When `opts.attempts` is supplied, each claim loop tries the fenced V2 queue
 * first and falls back to V1, and a V2 claim is driven by `driveOneAttempt`
 * instead. The two paths differ in every way that matters:
 *
 *   - identity   every claim carries a distinct `RunLeaseRef` (run + attempt +
 *                token + epoch) that every renew, append, checkpoint, cancel
 *                check, and seal echoes back;
 *   - IO         events and the checkpoint that terminates them commit in ONE
 *                `appendAttemptBatch` transaction — there is no separate
 *                checkpoint-save call to tear against;
 *   - fencing    a lost claim THROWS rather than returning `false`, and the
 *                fenced attempt then performs no store mutation at all — not
 *                even a terminal one. Another attempt owns that evidence now;
 *   - terminal   completed/denied/failed/cancelled all go through `sealAttempt`,
 *                which mints the one-shot finalization grant and its durable
 *                obligation in the seal transaction. The worker never invokes
 *                evidence finalization itself.
 *
 * `opts.attempts` being optional IS the V2 claim gate: `./main.ts` wires the V1
 * path only, so no V2 attempt is claimed before finalization consumption
 * exists to satisfy the obligations a seal creates. Nothing in the tree
 * implements `AttemptTurnDriver` yet, so `driveOneAttempt` below is exercised
 * by tests only — read it as a specified-but-unshipped path.
 */
import { hostname } from "node:os";
import { isRunLeaseFencedError } from "@oxagen/agent-runner/run-errors";
import { computeBackoffDelayMs } from "./backoff";
import {
  assertContiguousAttemptSeqs,
  AttemptSeqCounter,
  firstSeqForRun,
  SeqCounter,
} from "./seq";
import { decideAttemptTerminalAction, decideTerminalAction } from "./terminal";
import type { WorkerSealStatus } from "./terminal";
import type {
  AgentWorker,
  AttemptCheckpointRecord,
  AttemptEventEmission,
  AttemptEventRecord,
  AttemptTurnOutcome,
  AttemptWorkerOptions,
  ClaimedRun,
  ClaimedRunV2,
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

/**
 * The single terminal-stage event type; the seal appends it in its own
 * transaction.
 *
 * Spelled here rather than imported from `@oxagen/agent-runner`, which exports
 * the canonical constant of the same name: that constant lives in
 * `event-payload-registry.ts`, and importing it would pull zod and the whole
 * closed-vocabulary registry into a harness whose only other platform import is
 * the leaf `run-errors` module. The store checks every event type against the
 * registry, so a drift between the two spellings fails loudly at the first
 * seal rather than silently.
 */
export const TERMINAL_EVENT_TYPE = "terminal.attempt_terminated";

/**
 * `reason_code` shape the V2 terminal-event schema accepts. A reason that does
 * not match is dropped FROM THE EVENT PAYLOAD rather than sent: the reason is
 * an annotation, and letting a malformed one reject the terminal event would
 * leave the attempt unsealed — no seal means no finalization grant, which is
 * the exact failure the seal transaction exists to prevent.
 *
 * The seal row still records the raw value (`sealAttempt`'s own `reasonCode`
 * argument, unfiltered), so a malformed reason survives as an annotation on
 * `agent_run_attempt_seals` while being absent from the event stream. The two
 * can therefore disagree; only the event stream is digested evidence.
 */
const REASON_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** `${hostname}:${pid}` — stable per process, unique enough per host to debug claimed-by. */
export function defaultWorkerId(): string {
  return `${hostname()}:${process.pid}`;
}

/** The `terminal.attempt_terminated` payload, minus anything unproven. */
export function buildTerminalEventPayload(
  terminalStatus: WorkerSealStatus,
  reasonCode: string | undefined,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { terminal_status: terminalStatus };
  // Error and result DIGESTS are legitimate terminal-payload fields, but the
  // worker has no hasher here and a raw message may carry paths, stdout, or
  // source. They are omitted; the message itself travels on the run row
  // via `sealAttempt`'s `error`, never on the event.
  if (reasonCode !== undefined && REASON_CODE_RE.test(reasonCode)) {
    payload.reason_code = reasonCode;
  }
  return payload;
}

/**
 * Was this failure a lost claim? A fenced attempt must stop dead: the events it
 * would go on to write belong to an attempt that no longer owns the run.
 */
function isFence(err: unknown): boolean {
  return isRunLeaseFencedError(err);
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
  // Undefined ⇒ V2 claims disabled for this process (the shipped configuration).
  const attempts: AttemptWorkerOptions | undefined = opts.attempts;
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
      // Once the lease is gone this RESOLVES without writing anything, the
      // same shape `commit` uses on the V2 path: the driver's signal is
      // already aborted, and a rejection here would only add a spurious
      // driver error to a run the worker is forbidden to touch again.
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

  /**
   * Drives one claimed V2 attempt to a sealed terminal decision. Never throws.
   *
   * Contrast with `driveOneRun`: there is no `false`-means-lost-lease anywhere
   * here. Every fenced operation throws, and the FIRST fence stops the attempt
   * dead — no further append, no checkpoint, and above all no seal. The lease
   * reclaimer will seal this attempt as `abandoned` (with the canonical empty
   * stream digest when nothing was ever accepted) and mint its finalization
   * grant, so evidence is never stranded by this early exit.
   */
  async function driveOneAttempt(
    cfg: AttemptWorkerOptions,
    claimed: ClaimedRunV2,
  ): Promise<void> {
    const lease = claimed.lease;
    const controller = new AbortController();
    let fenced = false;
    let cancelled = false;
    // ALWAYS 1, even for a successor that restored a checkpoint: `attempt_seq`
    // is a position within ONE attempt, and the restored position travels on
    // `claimed.v2.restore`, never as a sequence offset.
    const seqCounter = new AttemptSeqCounter();
    let pending: AttemptEventRecord[] = [];
    /** Highest sequence the store has ACCEPTED. 0 until the first commit lands. */
    let lastAppendedSeq = 0;

    function fence(err: unknown, phase: string): void {
      if (fenced) return;
      fenced = true;
      controller.abort();
      reportError(err, { runId: lease.runId, phase });
    }

    /**
     * Commit the buffered batch — and, when supplied, the checkpoint that
     * terminates it — in ONE `appendAttemptBatch` transaction. There is no
     * separate checkpoint-save call, so events and their checkpoint can never
     * tear apart: either both are durable or neither is.
     */
    async function commit(checkpoint?: AttemptCheckpointRecord): Promise<void> {
      // A fenced attempt's checkpoint call RESOLVES rather than rejecting:
      // nothing was written, but there is nothing useful to tell the driver
      // either, and `controller.signal` is already aborted so a driver that
      // honors the signal stops on its own.
      if (fenced) return;
      if (pending.length === 0) {
        if (!checkpoint) return;
        // A checkpoint is bound to the final event of the append it terminates
        // — there is no event to bind to. Refusing locally names the mistake at
        // the call site instead of surfacing it from inside a transaction.
        throw new RangeError(
          "a checkpoint must terminate at least one buffered event",
        );
      }
      const batch = pending;
      assertContiguousAttemptSeqs(
        lastAppendedSeq,
        batch.map((event) => event.attemptSeq),
      );
      pending = [];
      try {
        const result = await cfg.store.appendAttemptBatch({
          lease,
          events: batch,
          checkpoint,
        });
        lastAppendedSeq = result.lastAttemptSeq;
      } catch (err) {
        if (isFence(err)) {
          fence(err, "attempt-append");
          throw err;
        }
        // The transaction rolled back — events AND checkpoint together. Put the
        // batch back with its sequences and observation times UNTOUCHED, so the
        // next commit replays it byte-identically: a re-stamped `observedAt`
        // moves `event_digest` and turns a benign retry into a
        // same-sequence/different-digest integrity conflict.
        //
        // Only the EVENTS are restored. The `checkpoint` argument is not, so a
        // driver whose `io.checkpoint(...)` rejected must re-issue it — the
        // rejection is its notice. A driver that swallows the rejection and
        // keeps going gets its events committed by the next commit with no
        // checkpoint bound to them, and a successor restores from the previous
        // one.
        pending = [...batch, ...pending];
        throw err;
      }
    }

    function onEvent(emission: AttemptEventEmission): void {
      if (fenced) return; // another attempt owns this run's evidence now
      const hasInline = emission.payload !== undefined;
      const hasEncrypted = emission.encryptedPayloadRef !== undefined;
      if (hasInline === hasEncrypted) {
        throw new RangeError(
          `event ${emission.eventType} must carry exactly one of an inline ` +
            `payload or an encrypted payload reference`,
        );
      }
      if (hasEncrypted && emission.payloadDigest === undefined) {
        throw new RangeError(
          `event ${emission.eventType} carries an encrypted payload reference ` +
            `without its precomputed payload digest`,
        );
      }
      pending.push({
        ...emission,
        attemptSeq: seqCounter.assign(),
        // Stamped once, here, and never re-stamped on replay.
        observedAt: new Date().toISOString(),
      });
    }

    const stopLeaseTicker = startTicker(
      async () => {
        if (fenced) return;
        try {
          await cfg.store.renewAttemptLease(lease, cfg.leaseSeconds);
        } catch (err) {
          if (isFence(err)) {
            fence(err, "attempt-lease-renew");
            return;
          }
          throw err; // transient: reported by the ticker, retried next tick
        }
      },
      leaseRenewIntervalMs,
      (err) =>
        reportError(err, { runId: lease.runId, phase: "attempt-lease-renew" }),
    );

    const stopCancelTicker = startTicker(
      async () => {
        if (fenced || cancelled) return;
        try {
          if (await cfg.store.isAttemptCancelRequested(lease)) {
            cancelled = true;
            controller.abort();
          }
        } catch (err) {
          if (isFence(err)) {
            // A fenced attempt has no standing to ask whether to keep going —
            // it must stop either way.
            fence(err, "attempt-cancel-poll");
            return;
          }
          throw err;
        }
      },
      cancelPollIntervalMs,
      (err) =>
        reportError(err, { runId: lease.runId, phase: "attempt-cancel-poll" }),
    );
    activeCancelPollStops.add(stopCancelTicker);

    let driverError: { error: unknown } | null = null;
    let outcome: AttemptTurnOutcome | null = null;
    try {
      outcome = await cfg.driveTurn(claimed, {
        onEvent,
        checkpoint: (record) => commit(record),
        signal: controller.signal,
      });
    } catch (err) {
      // A fence rethrown out of `commit` is already recorded; it must not be
      // mistaken for a driver failure, which would try to seal a fenced attempt.
      if (!fenced && isFence(err)) fence(err, "attempt-drive");
      else if (!fenced) driverError = { error: err };
    } finally {
      stopCancelTicker();
      activeCancelPollStops.delete(stopCancelTicker);
    }

    // Final commit before the seal, unless the attempt is already fenced.
    if (!fenced) {
      try {
        await commit();
      } catch (err) {
        if (!fenced) {
          reportError(err, {
            runId: lease.runId,
            phase: "attempt-final-commit",
          });
          if (driverError === null) driverError = { error: err };
        }
      }
    }

    const decision = decideAttemptTerminalAction({
      fenced,
      cancelled,
      driverError,
      outcome,
    });
    try {
      if (decision.kind === "none") return;
      // The terminal event continues from what the store ACCEPTED, not from the
      // local counter: events dropped by a failed final commit never became
      // durable, and numbering past them would leave a gap the append refuses.
      const handle = await cfg.store.sealAttempt({
        lease,
        terminalStatus: decision.status,
        reasonCode: decision.reasonCode,
        terminalEvent: {
          attemptSeq: lastAppendedSeq + 1,
          eventType: TERMINAL_EVENT_TYPE,
          observedAt: new Date().toISOString(),
          payload: buildTerminalEventPayload(
            decision.status,
            decision.reasonCode,
          ),
        },
        sealerWorkerId: workerId,
        error: decision.error,
        result: decision.result,
      });
      if (cfg.onSealed) {
        try {
          cfg.onSealed(handle);
        } catch {
          // Observability only — see AttemptWorkerOptions.onSealed. The
          // obligation is already durable; nothing here can strand it.
        }
      }
    } catch (err) {
      // A seal that could not be written leaves an unsealed attempt whose lease
      // simply expires; the reclaimer seals it as `abandoned` and mints its
      // grant. Reported, never retried inline — retrying from a process that
      // may itself be dying is how double-terminal races start.
      reportError(err, { runId: lease.runId, phase: "attempt-seal" });
    } finally {
      stopLeaseTicker();
    }
  }

  async function claimLoop(): Promise<void> {
    let attempt = 0;
    while (!stopped) {
      // V2 first, V1 second: fenced attempts take priority when this process is
      // configured for them, and already-enqueued legacy work keeps draining
      // through the same loop either way.
      if (attempts) {
        let claimedV2: ClaimedRunV2 | null = null;
        try {
          claimedV2 = await attempts.store.claimNextRunV2(workerId, {
            engine: attempts.engine,
            restorableEngineStateSchemas: attempts.restorableEngineStateSchemas,
            leaseSeconds: attempts.leaseSeconds,
          });
        } catch (err) {
          reportError(err, { phase: "attempt-claim" });
        }
        if (claimedV2) {
          attempt = 0;
          await driveOneAttempt(attempts, claimedV2);
          continue;
        }
      }

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
