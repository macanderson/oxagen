/**
 * Coverage for the durable-run worker harness (agent-engine v2 Phase 2c):
 * claim → drive → flush → complete; resume seq continuity; lease-loss abort +
 * store-write cutoff; cancel-request abort + cancelRun; driver throw →
 * failRun; stop() draining an in-flight run; flush-before-checkpoint
 * ordering; crash-then-resume seq stability; plus the extracted pure
 * decision functions (backoff math, seq assignment, terminal-state
 * selection). House style: dependency injection — a hand-rolled RunStore
 * fake (vi.fn per method, overridable) and controlled deferreds for
 * concurrency; no vi.mock. The lease-renewal/cancel-poll tests are the one
 * place real (tiny) timers are unavoidable — the feature IS an interval —
 * kept to single-digit-ms intervals so they stay fast and non-flaky.
 */
import { describe, it, expect, vi } from "vitest";
import { computeBackoffDelayMs } from "./backoff";
import { firstSeqForRun, SeqCounter } from "./seq";
import { decideTerminalAction } from "./terminal";
import { defaultWorkerId } from "./worker";
import { createAgentWorker } from "./index";
import type { ClaimedRun, RunEventRecord, RunStore, TurnDriver } from "./types";

// ── Test helpers ─────────────────────────────────────────────────────────────

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Await pending microtasks so queued promise chains settle before assertions. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

let claimCounter = 0;
function makeClaimedRun(overrides: Partial<ClaimedRun> = {}): ClaimedRun {
  claimCounter += 1;
  return {
    runId: `run-${claimCounter}`,
    publicId: `pub-${claimCounter}`,
    orgId: "org-1",
    workspaceId: "ws-1",
    surface: "chat",
    spec: {},
    attempts: 1,
    checkpoint: null,
    checkpointSeq: 0,
    ...overrides,
  };
}

/** A fully-stubbed RunStore (every method a vi.fn with a benign default), overridable per test. */
function makeStore(overrides: Partial<RunStore> = {}): RunStore {
  return {
    claimNextRun: vi.fn(async (): Promise<ClaimedRun | null> => null),
    renewLease: vi.fn(async (): Promise<boolean> => true),
    appendEvents: vi.fn(async (): Promise<void> => {}),
    saveCheckpoint: vi.fn(async (): Promise<boolean> => true),
    completeRun: vi.fn(async (): Promise<boolean> => true),
    failRun: vi.fn(async (): Promise<boolean> => true),
    cancelRun: vi.fn(async (): Promise<boolean> => true),
    isCancelRequested: vi.fn(async (): Promise<boolean> => false),
    ...overrides,
  };
}

// ── Pure functions ────────────────────────────────────────────────────────────

describe("computeBackoffDelayMs", () => {
  it("returns 0 when random() is 0, at any attempt", () => {
    expect(
      computeBackoffDelayMs(0, { baseMs: 2000, capMs: 15000, random: () => 0 }),
    ).toBe(0);
    expect(
      computeBackoffDelayMs(10, {
        baseMs: 2000,
        capMs: 15000,
        random: () => 0,
      }),
    ).toBe(0);
  });

  it("stays within [0, baseMs) at attempt 0 (2^0 = 1)", () => {
    const delay = computeBackoffDelayMs(0, {
      baseMs: 2000,
      capMs: 15000,
      random: () => 0.999999,
    });
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(2000);
  });

  it("grows exponentially before the cap", () => {
    const at1 = computeBackoffDelayMs(1, {
      baseMs: 1000,
      capMs: 100_000,
      random: () => 1,
    });
    const at2 = computeBackoffDelayMs(2, {
      baseMs: 1000,
      capMs: 100_000,
      random: () => 1,
    });
    // attempt=1 → base*2^1=2000 bound; attempt=2 → base*2^2=4000 bound (random=1 → just under bound).
    expect(at2).toBeGreaterThan(at1);
  });

  it("never exceeds capMs regardless of attempt", () => {
    const delay = computeBackoffDelayMs(30, {
      baseMs: 2000,
      capMs: 15000,
      random: () => 0.999999,
    });
    expect(delay).toBeLessThan(15000);
    expect(delay).toBeGreaterThanOrEqual(0);
  });

  it("falls back to capMs when 2^attempt overflows to Infinity", () => {
    const delay = computeBackoffDelayMs(2000, {
      baseMs: 2000,
      capMs: 15000,
      random: () => 0.5,
    });
    expect(delay).toBe(Math.floor(0.5 * 15000));
  });

  it("defaults to Math.random when none is injected", () => {
    const delay = computeBackoffDelayMs(0, { baseMs: 2000, capMs: 15000 });
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(2000);
  });
});

describe("firstSeqForRun / SeqCounter", () => {
  it("starts a fresh run (checkpointSeq 0) at seq 1", () => {
    expect(firstSeqForRun({ checkpointSeq: 0 })).toBe(1);
  });

  it("resumes a checkpointed run at checkpointSeq + 1", () => {
    expect(firstSeqForRun({ checkpointSeq: 41 })).toBe(42);
  });

  it("assigns monotonically increasing seqs starting at the given first seq", () => {
    const counter = new SeqCounter(6);
    expect(counter.assign()).toBe(6);
    expect(counter.assign()).toBe(7);
    expect(counter.assign()).toBe(8);
  });
});

describe("decideTerminalAction", () => {
  it("lease loss wins over everything else", () => {
    expect(
      decideTerminalAction({
        leaseLost: true,
        cancelled: true,
        driverError: { error: new Error("x") },
        result: "r",
      }),
    ).toEqual({ kind: "none" });
  });

  it("a cancel request beats a driver error", () => {
    expect(
      decideTerminalAction({
        leaseLost: false,
        cancelled: true,
        driverError: { error: new Error("x") },
        result: "r",
      }),
    ).toEqual({ kind: "cancel" });
  });

  it("a driver Error throw becomes fail with its message", () => {
    expect(
      decideTerminalAction({
        leaseLost: false,
        cancelled: false,
        driverError: { error: new Error("boom") },
        result: undefined,
      }),
    ).toEqual({ kind: "fail", message: "boom" });
  });

  it("a non-Error throw is stringified", () => {
    expect(
      decideTerminalAction({
        leaseLost: false,
        cancelled: false,
        driverError: { error: "raw string throw" },
        result: undefined,
      }),
    ).toEqual({ kind: "fail", message: "raw string throw" });
  });

  it("no lease loss, no cancel, no driver error → complete with the result", () => {
    expect(
      decideTerminalAction({
        leaseLost: false,
        cancelled: false,
        driverError: null,
        result: { ok: true },
      }),
    ).toEqual({ kind: "complete", result: { ok: true } });
  });
});

describe("defaultWorkerId", () => {
  it("is `${hostname}:${pid}`", async () => {
    const os = await import("node:os");
    expect(defaultWorkerId()).toBe(`${os.hostname()}:${process.pid}`);
  });
});

// ── createAgentWorker — integration behavior ─────────────────────────────────

describe("createAgentWorker — happy path", () => {
  it("claims a run, drives it, flushes events in order, and completes it", async () => {
    const claimed = makeClaimedRun();
    const appendCalls: RunEventRecord[][] = [];
    const done = deferred<[string, string, unknown]>();
    const store = makeStore({
      claimNextRun: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      appendEvents: vi.fn(
        async (
          _r: string,
          _o: string,
          _w: string,
          events: RunEventRecord[],
        ) => {
          appendCalls.push(events);
        },
      ),
      completeRun: vi.fn(
        async (runId: string, workerId: string, result: unknown) => {
          done.resolve([runId, workerId, result]);
          return true;
        },
      ),
    });

    const driveTurn: TurnDriver = async (_run, io) => {
      io.onEvent("step-start", { n: 1 });
      io.onEvent("step-end", { n: 1 });
      await io.checkpoint({ step: 1 });
      io.onEvent("final", { text: "done" });
      return { result: { text: "done" } };
    };

    const worker = createAgentWorker({ store, driveTurn });
    worker.start();
    const [runId, workerId, result] = await done.promise;
    await worker.stop();

    expect(runId).toBe(claimed.runId);
    expect(typeof workerId).toBe("string");
    expect(result).toEqual({ text: "done" });
    expect(appendCalls).toEqual([
      [
        { seq: 1, type: "step-start", payload: { n: 1 } },
        { seq: 2, type: "step-end", payload: { n: 1 } },
      ],
      [{ seq: 3, type: "final", payload: { text: "done" } }],
    ]);
    expect(store.saveCheckpoint).toHaveBeenCalledWith(
      claimed.runId,
      expect.any(String),
      2,
      {
        step: 1,
      },
    );
  });
});

describe("createAgentWorker — resume from checkpoint", () => {
  it("continues seq numbering from checkpointSeq + 1 after a restored checkpoint", async () => {
    const claimed = makeClaimedRun({
      checkpoint: { some: "state" },
      checkpointSeq: 5,
    });
    const appendCalls: RunEventRecord[][] = [];
    const done = deferred();
    const store = makeStore({
      claimNextRun: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      appendEvents: vi.fn(
        async (
          _r: string,
          _o: string,
          _w: string,
          events: RunEventRecord[],
        ) => {
          appendCalls.push(events);
        },
      ),
      completeRun: vi.fn(async () => {
        done.resolve();
        return true;
      }),
    });

    let sawCheckpoint: unknown;
    const driveTurn: TurnDriver = async (run, io) => {
      sawCheckpoint = run.checkpoint;
      io.onEvent("resumed", {});
      return { result: {} };
    };

    const worker = createAgentWorker({ store, driveTurn });
    worker.start();
    await done.promise;
    await worker.stop();

    expect(sawCheckpoint).toEqual({ some: "state" });
    expect(appendCalls.flat()).toEqual([
      { seq: 6, type: "resumed", payload: {} },
    ]);
  });
});

describe("createAgentWorker — event flush precedes checkpoint", () => {
  it("flushes buffered events before saving a checkpoint", async () => {
    const order: string[] = [];
    const claimed = makeClaimedRun();
    const done = deferred();
    const store = makeStore({
      claimNextRun: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      appendEvents: vi.fn(async () => {
        order.push("append");
      }),
      saveCheckpoint: vi.fn(async () => {
        order.push("checkpoint");
        return true;
      }),
      completeRun: vi.fn(async () => {
        done.resolve();
        return true;
      }),
    });

    const driveTurn: TurnDriver = async (_run, io) => {
      io.onEvent("e", {});
      await io.checkpoint({});
      return { result: null };
    };

    const worker = createAgentWorker({ store, driveTurn });
    worker.start();
    await done.promise;
    await worker.stop();

    expect(order).toEqual(["append", "checkpoint"]);
  });
});

describe("createAgentWorker — driver throw", () => {
  it("fails the run with the thrown error's message", async () => {
    const claimed = makeClaimedRun();
    const done = deferred<[string, string, string]>();
    const store = makeStore({
      claimNextRun: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      failRun: vi.fn(
        async (runId: string, workerId: string, message: string) => {
          done.resolve([runId, workerId, message]);
          return true;
        },
      ),
    });

    const driveTurn: TurnDriver = async () => {
      throw new Error("driver blew up");
    };

    const worker = createAgentWorker({ store, driveTurn });
    worker.start();
    const [runId, , message] = await done.promise;
    await worker.stop();

    expect(runId).toBe(claimed.runId);
    expect(message).toBe("driver blew up");
    expect(store.completeRun).not.toHaveBeenCalled();
    expect(store.cancelRun).not.toHaveBeenCalled();
  });
});

describe("createAgentWorker — lease loss", () => {
  it("aborts the signal and makes no further store writes once the lease is lost", async () => {
    const claimed = makeClaimedRun();
    const store = makeStore({
      claimNextRun: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      renewLease: vi.fn(async () => false), // lost on the very first renewal tick
    });

    const driveTurn: TurnDriver = (_run, io) =>
      new Promise((resolve) => {
        io.onEvent("before-abort", {}); // buffered — must never reach the store
        io.signal.addEventListener("abort", () => {
          io.onEvent("after-abort", {}); // dropped: lease already lost
          void io.checkpoint({}).then(() => resolve({ result: "ignored" }));
        });
      });

    const worker = createAgentWorker({
      store,
      driveTurn,
      leaseRenewIntervalMs: 10,
    });
    worker.start();
    await new Promise((r) => setTimeout(r, 80)); // let the renewal tick fire
    await worker.stop();

    expect(store.appendEvents).not.toHaveBeenCalled();
    expect(store.saveCheckpoint).not.toHaveBeenCalled();
    expect(store.completeRun).not.toHaveBeenCalled();
    expect(store.failRun).not.toHaveBeenCalled();
    expect(store.cancelRun).not.toHaveBeenCalled();
  });

  it("treats a false return from saveCheckpoint as lease loss too", async () => {
    const claimed = makeClaimedRun();
    const store = makeStore({
      claimNextRun: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      saveCheckpoint: vi.fn(async () => false),
    });

    let signalSeen: AbortSignal | undefined;
    const driveTurn: TurnDriver = async (_run, io) => {
      signalSeen = io.signal;
      io.onEvent("e", {});
      await io.checkpoint({});
      // The driver "finished successfully" from its own point of view — the
      // lease-loss decision must still suppress completion.
      return { result: "should-not-complete" };
    };

    const worker = createAgentWorker({ store, driveTurn });
    worker.start();
    await settle();
    await worker.stop();

    expect(signalSeen?.aborted).toBe(true);
    expect(store.completeRun).not.toHaveBeenCalled();
  });
});

describe("createAgentWorker — cancel request", () => {
  it("aborts the signal, flushes buffered events, and calls cancelRun (not completeRun/failRun)", async () => {
    const claimed = makeClaimedRun();
    const flushed: RunEventRecord[][] = [];
    const store = makeStore({
      claimNextRun: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      isCancelRequested: vi.fn(async () => true),
      appendEvents: vi.fn(
        async (
          _r: string,
          _o: string,
          _w: string,
          events: RunEventRecord[],
        ) => {
          flushed.push(events);
        },
      ),
    });

    const driveTurn: TurnDriver = (_run, io) =>
      new Promise((resolve) => {
        io.onEvent("before-cancel", {});
        io.signal.addEventListener("abort", () =>
          resolve({ result: "ignored" }),
        );
      });

    const worker = createAgentWorker({
      store,
      driveTurn,
      cancelPollIntervalMs: 10,
    });
    worker.start();
    await new Promise((r) => setTimeout(r, 80));
    await worker.stop();

    expect(store.cancelRun).toHaveBeenCalledWith(
      claimed.runId,
      expect.any(String),
    );
    expect(store.completeRun).not.toHaveBeenCalled();
    expect(store.failRun).not.toHaveBeenCalled();
    expect(flushed.flat()).toEqual([
      { seq: 1, type: "before-cancel", payload: {} },
    ]);
  });
});

describe("createAgentWorker — transient ticker errors", () => {
  it("reports a renewLease rejection via onError without treating it as lease loss", async () => {
    const claimed = makeClaimedRun();
    const boom = new Error("network blip");
    let calls = 0;
    const store = makeStore({
      claimNextRun: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      renewLease: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw boom;
        return true;
      }),
    });
    const onError = vi.fn();
    const gate = deferred<{ result: unknown }>();
    const driveTurn: TurnDriver = () => gate.promise;

    const worker = createAgentWorker({
      store,
      driveTurn,
      leaseRenewIntervalMs: 10,
      onError,
    });
    worker.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(onError).toHaveBeenCalledWith(boom, {
      runId: claimed.runId,
      phase: "lease-renew",
    });

    gate.resolve({ result: "ok" });
    await worker.stop();
    expect(store.completeRun).toHaveBeenCalledWith(
      claimed.runId,
      expect.any(String),
      "ok",
    );
  });

  it("reports an isCancelRequested rejection via onError without treating it as a cancel", async () => {
    const claimed = makeClaimedRun();
    const boom = new Error("network blip");
    const store = makeStore({
      claimNextRun: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      isCancelRequested: vi
        .fn()
        .mockRejectedValueOnce(boom)
        .mockResolvedValue(false),
    });
    const onError = vi.fn();
    const gate = deferred<{ result: unknown }>();
    const driveTurn: TurnDriver = () => gate.promise;

    const worker = createAgentWorker({
      store,
      driveTurn,
      cancelPollIntervalMs: 10,
      onError,
    });
    worker.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(onError).toHaveBeenCalledWith(boom, {
      runId: claimed.runId,
      phase: "cancel-poll",
    });

    gate.resolve({ result: "ok" });
    await worker.stop();
    expect(store.completeRun).toHaveBeenCalledWith(
      claimed.runId,
      expect.any(String),
      "ok",
    );
  });

  it("swallows a throwing onError sink and keeps going after a transient claim error", async () => {
    const claimed = makeClaimedRun();
    const claimErr = new Error("db blip");
    const done = deferred();
    const store = makeStore({
      claimNextRun: vi
        .fn()
        .mockRejectedValueOnce(claimErr)
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      completeRun: vi.fn(async () => {
        done.resolve();
        return true;
      }),
    });
    const driveTurn: TurnDriver = async () => ({ result: "ok" });
    const badOnError = vi.fn(() => {
      throw new Error("sink itself is broken");
    });

    const worker = createAgentWorker({
      store,
      driveTurn,
      onError: badOnError,
      pollIntervalMs: 1,
    });
    worker.start();
    await done.promise;
    await worker.stop();

    expect(badOnError).toHaveBeenCalledWith(claimErr, { phase: "claim" });
    expect(store.completeRun).toHaveBeenCalled();
  });
});

describe("createAgentWorker — no onError sink configured", () => {
  it("silently drops a claim error when onError is omitted, and keeps going", async () => {
    const claimed = makeClaimedRun();
    const claimErr = new Error("db blip, no sink configured");
    const done = deferred();
    const store = makeStore({
      claimNextRun: vi
        .fn()
        .mockRejectedValueOnce(claimErr)
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      completeRun: vi.fn(async () => {
        done.resolve();
        return true;
      }),
    });
    const driveTurn: TurnDriver = async () => ({ result: "ok" });
    // No onError — reportError must no-op instead of throwing.
    const worker = createAgentWorker({ store, driveTurn, pollIntervalMs: 1 });
    worker.start();
    await done.promise;
    await worker.stop();

    expect(store.completeRun).toHaveBeenCalled();
  });
});

describe("createAgentWorker — stop() draining", () => {
  it("waits for an already in-flight run to finish before resolving", async () => {
    const claimed = makeClaimedRun();
    const store = makeStore({
      claimNextRun: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
    });
    const gate = deferred<{ result: unknown }>();
    const driveTurn: TurnDriver = () => gate.promise;
    const worker = createAgentWorker({ store, driveTurn });

    worker.start();
    let stopResolved = false;
    const stopPromise = worker.stop().then(() => {
      stopResolved = true;
    });

    await settle();
    expect(stopResolved).toBe(false); // still draining — the gate hasn't opened
    expect(store.completeRun).not.toHaveBeenCalled();

    gate.resolve({ result: "done" });
    await stopPromise;

    expect(stopResolved).toBe(true);
    expect(store.completeRun).toHaveBeenCalledWith(
      claimed.runId,
      expect.any(String),
      "done",
    );
  });
});

describe("createAgentWorker — concurrency", () => {
  it("drives up to `concurrency` runs in parallel", async () => {
    const claimed1 = makeClaimedRun();
    const claimed2 = makeClaimedRun();
    const queue: (ClaimedRun | null)[] = [claimed1, claimed2];
    const store = makeStore({
      claimNextRun: vi.fn(async () => queue.shift() ?? null),
    });
    const gates = [
      deferred<{ result: unknown }>(),
      deferred<{ result: unknown }>(),
    ];
    let callIndex = 0;
    const driveTurn: TurnDriver = () => gates[callIndex++]!.promise;

    const worker = createAgentWorker({ store, driveTurn, concurrency: 2 });
    worker.start();
    await settle();
    expect(callIndex).toBe(2); // both slots claimed + started a run concurrently

    gates[0]!.resolve({ result: "a" });
    gates[1]!.resolve({ result: "b" });
    await settle();
    await worker.stop();

    expect(store.completeRun).toHaveBeenCalledTimes(2);
  });
});

describe("createAgentWorker — flush retry after an append failure", () => {
  it("retries a failed flush's batch on the next flush attempt without losing events", async () => {
    const claimed = makeClaimedRun();
    const appendCalls: RunEventRecord[][] = [];
    let appendAttempt = 0;
    const done = deferred();
    const store = makeStore({
      claimNextRun: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      appendEvents: vi.fn(
        async (
          _r: string,
          _o: string,
          _w: string,
          events: RunEventRecord[],
        ) => {
          appendAttempt += 1;
          if (appendAttempt === 1) throw new Error("transient db error");
          appendCalls.push(events);
        },
      ),
      completeRun: vi.fn(async () => {
        done.resolve();
        return true;
      }),
    });

    const driveTurn: TurnDriver = async (_run, io) => {
      io.onEvent("a", {});
      let firstCheckpointFailed = false;
      try {
        await io.checkpoint({ step: 1 });
      } catch {
        firstCheckpointFailed = true;
      }
      expect(firstCheckpointFailed).toBe(true);
      io.onEvent("b", {}); // buffered alongside the retried "a"
      await io.checkpoint({ step: 2 }); // retries "a" together with "b"
      return { result: "done" };
    };

    const worker = createAgentWorker({ store, driveTurn });
    worker.start();
    await done.promise;
    await worker.stop();

    expect(appendCalls).toEqual([
      [
        { seq: 1, type: "a", payload: {} },
        { seq: 2, type: "b", payload: {} },
      ],
    ]);
  });
});

describe("createAgentWorker — final-flush failure", () => {
  it("treats a final-flush failure as a driver error, failing the run instead of completing it", async () => {
    const claimed = makeClaimedRun();
    const flushErr = new Error("append down at completion");
    const done = deferred<string>();
    const onError = vi.fn();
    const store = makeStore({
      claimNextRun: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      appendEvents: vi.fn(async () => {
        throw flushErr;
      }),
      failRun: vi.fn(
        async (_runId: string, _workerId: string, message: string) => {
          done.resolve(message);
          return true;
        },
      ),
    });
    const driveTurn: TurnDriver = async (_run, io) => {
      io.onEvent("e", {}); // never successfully flushed
      return { result: "would have completed" };
    };
    const worker = createAgentWorker({ store, driveTurn, onError });
    worker.start();
    const message = await done.promise;
    await worker.stop();

    expect(message).toBe(flushErr.message);
    expect(onError).toHaveBeenCalledWith(flushErr, {
      runId: claimed.runId,
      phase: "final-flush",
    });
    expect(store.completeRun).not.toHaveBeenCalled();
  });
});

describe("createAgentWorker — terminal store call outcomes", () => {
  it("reports a rejected terminal store call via onError without throwing", async () => {
    const claimed = makeClaimedRun();
    const boom = new Error("db down at completion");
    const reported = deferred<[unknown, unknown]>();
    const onError = vi.fn((err: unknown, ctx: unknown) => {
      reported.resolve([err, ctx]);
    });
    const store = makeStore({
      claimNextRun: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      completeRun: vi.fn(async () => {
        throw boom;
      }),
    });
    const driveTurn: TurnDriver = async () => ({ result: "ok" });
    const worker = createAgentWorker({ store, driveTurn, onError });
    worker.start();
    const [err, ctx] = await reported.promise;
    await worker.stop();

    expect(err).toBe(boom);
    expect(ctx).toEqual({ runId: claimed.runId, phase: "terminal" });
  });

  it("tolerates a resolved false from completeRun (lost race) without reporting an error", async () => {
    const claimed = makeClaimedRun();
    const onError = vi.fn();
    const done = deferred();
    const store = makeStore({
      claimNextRun: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      completeRun: vi.fn(async () => {
        done.resolve();
        return false;
      }),
    });
    const driveTurn: TurnDriver = async () => ({ result: "ok" });
    const worker = createAgentWorker({ store, driveTurn, onError });
    worker.start();
    await done.promise;
    await worker.stop();

    expect(onError).not.toHaveBeenCalled();
  });
});

describe("createAgentWorker — crash-then-resume seq stability", () => {
  it("resuming from a checkpoint after a simulated crash continues seq without duplication", async () => {
    const allAppended: RunEventRecord[] = [];
    let savedSeq = -1;
    let savedCheckpoint: unknown;

    // "Worker 1" emits two events, checkpoints, then the process is killed —
    // modeled by a driveTurn that never resolves after the checkpoint. Its
    // tickers are set absurdly long so they never fire during this test.
    const claim1 = makeClaimedRun({ checkpointSeq: 0, checkpoint: null });
    const store1 = makeStore({
      claimNextRun: vi
        .fn()
        .mockResolvedValueOnce(claim1)
        .mockResolvedValue(null),
      appendEvents: vi.fn(
        async (
          _r: string,
          _o: string,
          _w: string,
          events: RunEventRecord[],
        ) => {
          allAppended.push(...events);
        },
      ),
      saveCheckpoint: vi.fn(
        async (_r: string, _w: string, seq: number, cp: unknown) => {
          savedSeq = seq;
          savedCheckpoint = cp;
          return true;
        },
      ),
    });
    const checkpointed = deferred();
    const driveTurn1: TurnDriver = async (_run, io) => {
      io.onEvent("a", {});
      io.onEvent("b", {});
      await io.checkpoint({ progress: 2 });
      checkpointed.resolve();
      return new Promise(() => {}); // never settles — the "crash"
    };
    const worker1 = createAgentWorker({
      store: store1,
      driveTurn: driveTurn1,
      leaseRenewIntervalMs: 1_000_000_000,
      cancelPollIntervalMs: 1_000_000_000,
    });
    worker1.start();
    await checkpointed.promise;

    expect(savedSeq).toBe(2);
    expect(savedCheckpoint).toEqual({ progress: 2 });

    // "Worker 2" claims the same run after the crash, resumed from exactly
    // what worker 1 checkpointed.
    const claim2 = makeClaimedRun({
      runId: claim1.runId,
      checkpointSeq: savedSeq,
      checkpoint: savedCheckpoint,
    });
    const done2 = deferred();
    const store2 = makeStore({
      claimNextRun: vi
        .fn()
        .mockResolvedValueOnce(claim2)
        .mockResolvedValue(null),
      appendEvents: vi.fn(
        async (
          _r: string,
          _o: string,
          _w: string,
          events: RunEventRecord[],
        ) => {
          allAppended.push(...events);
        },
      ),
      completeRun: vi.fn(async () => {
        done2.resolve();
        return true;
      }),
    });
    const driveTurn2: TurnDriver = async (run, io) => {
      expect(run.checkpoint).toEqual({ progress: 2 });
      io.onEvent("c", {});
      io.onEvent("d", {});
      return { result: "done" };
    };
    const worker2 = createAgentWorker({ store: store2, driveTurn: driveTurn2 });
    worker2.start();
    await done2.promise;
    await worker2.stop();

    const seqs = allAppended.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(new Set(seqs).size).toBe(seqs.length); // no client-side duplicates
  });
});
