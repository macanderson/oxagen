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
import { RunLeaseFencedError } from "@oxagen/agent-runner/run-errors";
import { computeBackoffDelayMs } from "./backoff";
import { firstSeqForRun, SeqCounter } from "./seq";
import { decideAttemptTerminalAction, decideTerminalAction } from "./terminal";
import {
  buildTerminalEventPayload,
  defaultWorkerId,
  TERMINAL_EVENT_TYPE,
} from "./worker";
import { createAgentWorker } from "./index";
import type {
  AppendAttemptBatchResult,
  AttemptRunStore,
  AttemptTurnDriver,
  ClaimedRun,
  ClaimedRunV2,
  RunEventRecord,
  RunStore,
  SealedAttemptHandle,
  TurnDriver,
} from "./types";

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

// ── V2 fenced-attempt helpers ────────────────────────────────────────────────

const ENGINE = {
  name: "oxagen-ts",
  version: "2.1.1",
  buildDigest: `sha256:${"b".repeat(64)}`,
};

let attemptCounter = 0;
function makeClaimedRunV2(overrides: Partial<ClaimedRunV2> = {}): ClaimedRunV2 {
  attemptCounter += 1;
  const runId = `run-v2-${attemptCounter}`;
  const attemptId = `attempt-${attemptCounter}`;
  return {
    runId,
    publicId: `arun_${attemptCounter.toString(16).padStart(22, "0")}`,
    orgId: "org-1",
    workspaceId: "ws-1",
    surface: "chat",
    spec: {},
    attempts: 1,
    checkpoint: null,
    checkpointSeq: 0,
    specVersion: 2,
    lease: {
      runId,
      attemptId,
      attemptPublicId: `arat_${attemptCounter.toString(16).padStart(22, "0")}`,
      leaseToken: `token-${attemptCounter}`,
      leaseEpoch: 1,
    },
    v2: {
      runKind: "general",
      specDigest: `sha256:${"a".repeat(64)}`,
      initiatingPrincipalId: "principal-human",
      agentPrincipalId: "principal-agent",
      agentId: "agent-1",
      agentVersionId: "agent-version-1",
      agentVersionChecksum: `sha256:${"c".repeat(64)}`,
      authorizationSnapshotId: "snapshot-1",
      parentRunId: null,
      repositoryBindingId: null,
      repositoryBindingPublicId: null,
      repositoryProvider: null,
      providerRepositoryId: null,
      repositoryConnectionId: null,
      configuredDefaultRef: null,
      baseCommitSha: null,
      baseTreeSha: null,
      retentionPolicyId: "retention-1",
      retentionPolicyPublicId: "rpv_0000000000000000000001",
      retentionPolicyDigest: `sha256:${"d".repeat(64)}`,
      maxAttempts: 3,
      attemptNumber: 1,
      engine: ENGINE,
      restore: null,
    },
    ...overrides,
  };
}

function makeSealedHandle(
  overrides: Partial<SealedAttemptHandle> = {},
): SealedAttemptHandle {
  const grantPublicId = "afg_00000000000000000000ff";
  return {
    runId: "run-v2-1",
    attemptId: "attempt-1",
    attemptPublicId: "arat_0000000000000000000001",
    sealId: "seal-1",
    terminalStatus: "completed",
    grantId: "grant-1",
    grantPublicId,
    submissionId: grantPublicId,
    obligationId: "obligation-1",
    eventCount: 1,
    finalEventDigest: `sha256:${"e".repeat(64)}`,
    eventStreamDigest: `sha256:${"f".repeat(64)}`,
    alreadySealed: false,
    ...overrides,
  };
}

/** Mirrors the store's own pointer arithmetic closely enough to drive the worker. */
function fakeAppendResult(
  events: readonly { attemptSeq: number }[],
): AppendAttemptBatchResult {
  const last = events[events.length - 1];
  return {
    events: events.map((e) => ({
      attemptSeq: e.attemptSeq,
      runSeq: String(e.attemptSeq),
      eventId: `event-${e.attemptSeq}`,
      eventDigest: `sha256:${String(e.attemptSeq).padStart(64, "0")}`,
      idempotent: false,
    })),
    lastAttemptSeq: last ? last.attemptSeq : 0,
    lastRunSeq: last ? String(last.attemptSeq) : "0",
    eventCount: events.length,
    eventStreamDigest: `sha256:${"f".repeat(64)}`,
    finalEventDigest: last
      ? `sha256:${String(last.attemptSeq).padStart(64, "0")}`
      : null,
    checkpointId: null,
  };
}

function makeAttemptStore(
  overrides: Partial<AttemptRunStore> = {},
): AttemptRunStore {
  return {
    claimNextRunV2: vi.fn(async (): Promise<ClaimedRunV2 | null> => null),
    renewAttemptLease: vi.fn(async () => ({ expiresAt: new Date() })),
    isAttemptCancelRequested: vi.fn(async (): Promise<boolean> => false),
    appendAttemptBatch: vi.fn(async (input) => fakeAppendResult(input.events)),
    sealAttempt: vi.fn(async () => makeSealedHandle()),
    ...overrides,
  };
}

const fenceError = (attemptId = "attempt-1"): RunLeaseFencedError =>
  new RunLeaseFencedError(attemptId, "fenced");

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

// ═══════════════════════════════════════════════════════════════════════════
// V2 — fenced immutable attempts
// ═══════════════════════════════════════════════════════════════════════════

describe("decideAttemptTerminalAction", () => {
  it("a fence suppresses every store mutation, beating cancel and driver error", () => {
    expect(
      decideAttemptTerminalAction({
        fenced: true,
        cancelled: true,
        driverError: { error: new Error("x") },
        outcome: null,
      }),
    ).toEqual({ kind: "none" });
  });

  it("a cancel request beats a driver error and seals as cancelled", () => {
    expect(
      decideAttemptTerminalAction({
        fenced: false,
        cancelled: true,
        driverError: { error: new Error("x") },
        outcome: null,
      }),
    ).toEqual({
      kind: "seal",
      status: "cancelled",
      reasonCode: "cancel_requested",
    });
  });

  it("a driver throw seals as failed with the message on the run row", () => {
    expect(
      decideAttemptTerminalAction({
        fenced: false,
        cancelled: false,
        driverError: { error: new Error("boom") },
        outcome: null,
      }),
    ).toEqual({
      kind: "seal",
      status: "failed",
      reasonCode: "driver_error",
      error: "boom",
    });
  });

  it("a deliberate denial seals as denied, not failed", () => {
    expect(
      decideAttemptTerminalAction({
        fenced: false,
        cancelled: false,
        driverError: null,
        outcome: {
          result: null,
          terminalStatus: "denied",
          reasonCode: "tool_denied",
        },
      }),
    ).toEqual({
      kind: "seal",
      status: "denied",
      reasonCode: "tool_denied",
      result: null,
    });
  });

  it("a clean settle with no explicit status seals as completed", () => {
    expect(
      decideAttemptTerminalAction({
        fenced: false,
        cancelled: false,
        driverError: null,
        outcome: { result: { ok: true } },
      }),
    ).toEqual({
      kind: "seal",
      status: "completed",
      reasonCode: undefined,
      result: { ok: true },
    });
  });
});

describe("buildTerminalEventPayload", () => {
  it("carries the terminal status and a well-formed reason code", () => {
    expect(buildTerminalEventPayload("cancelled", "cancel_requested")).toEqual({
      terminal_status: "cancelled",
      reason_code: "cancel_requested",
    });
  });

  it("drops a malformed reason code rather than letting it reject the seal", () => {
    expect(buildTerminalEventPayload("failed", "Driver Blew Up!")).toEqual({
      terminal_status: "failed",
    });
    expect(buildTerminalEventPayload("failed", "a".repeat(65))).toEqual({
      terminal_status: "failed",
    });
  });

  it("never carries a raw error or result body", () => {
    const payload = buildTerminalEventPayload("failed", "driver_error");
    expect(Object.keys(payload).sort()).toEqual([
      "reason_code",
      "terminal_status",
    ]);
  });
});

describe("createAgentWorker — V2 claims are off unless configured", () => {
  it("never issues a V2 claim when `attempts` is omitted", async () => {
    const attemptStore = makeAttemptStore();
    const done = deferred();
    const store = makeStore({
      claimNextRun: vi
        .fn()
        .mockResolvedValueOnce(makeClaimedRun())
        .mockResolvedValue(null),
      completeRun: vi.fn(async () => {
        done.resolve();
        return true;
      }),
    });
    const driveTurn: TurnDriver = async () => ({ result: "v1" });

    const worker = createAgentWorker({ store, driveTurn, concurrency: 1 });
    worker.start();
    await done.promise;
    await worker.stop();

    expect(attemptStore.claimNextRunV2).not.toHaveBeenCalled();
    expect(store.claimNextRun).toHaveBeenCalledWith(expect.any(String));
    // One argument only: the compatibility dispatcher claims V2 only when it is
    // handed a resolved engine identity, so V1-only wiring cannot claim V2.
    expect(
      (store.claimNextRun as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0],
    ).toHaveLength(1);
  });

  it("falls back to the draining V1 queue when the V2 queue is empty", async () => {
    const done = deferred();
    const attemptStore = makeAttemptStore();
    const store = makeStore({
      claimNextRun: vi
        .fn()
        .mockResolvedValueOnce(makeClaimedRun())
        .mockResolvedValue(null),
      completeRun: vi.fn(async () => {
        done.resolve();
        return true;
      }),
    });
    const worker = createAgentWorker({
      store,
      driveTurn: async () => ({ result: "v1" }),
      concurrency: 1,
      attempts: {
        store: attemptStore,
        driveTurn: async () => ({ result: "unused" }),
        engine: ENGINE,
      },
    });
    worker.start();
    await done.promise;
    await worker.stop();

    expect(attemptStore.claimNextRunV2).toHaveBeenCalled();
    expect(store.completeRun).toHaveBeenCalled();
  });

  it("reports a V2 claim error and still drains V1 on the same tick", async () => {
    const claimErr = new Error("v2 claim blew up");
    const onError = vi.fn();
    const done = deferred();
    const attemptStore = makeAttemptStore({
      claimNextRunV2: vi.fn(async () => {
        throw claimErr;
      }),
    });
    const store = makeStore({
      claimNextRun: vi
        .fn()
        .mockResolvedValueOnce(makeClaimedRun())
        .mockResolvedValue(null),
      completeRun: vi.fn(async () => {
        done.resolve();
        return true;
      }),
    });
    const worker = createAgentWorker({
      store,
      driveTurn: async () => ({ result: "v1" }),
      concurrency: 1,
      onError,
      attempts: {
        store: attemptStore,
        driveTurn: async () => ({ result: "unused" }),
        engine: ENGINE,
      },
    });
    worker.start();
    await done.promise;
    await worker.stop();

    expect(onError).toHaveBeenCalledWith(claimErr, { phase: "attempt-claim" });
    expect(store.completeRun).toHaveBeenCalled();
  });
});

describe("createAgentWorker — V2 attempt happy path", () => {
  it("commits events and their checkpoint in ONE batch, then seals with a terminal event", async () => {
    const claimed = makeClaimedRunV2();
    const sealed = deferred<SealedAttemptHandle>();
    const handle = makeSealedHandle();
    const attemptStore = makeAttemptStore({
      claimNextRunV2: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      sealAttempt: vi.fn(async () => handle),
    });
    const observed: SealedAttemptHandle[] = [];

    const driveTurn: AttemptTurnDriver = async (run, io) => {
      expect(run.lease.attemptPublicId).toBe(claimed.lease.attemptPublicId);
      io.onEvent({
        eventType: "context.frames_selected",
        payload: { frame_count: 2 },
      });
      io.onEvent({
        eventType: "model.call_completed",
        encryptedPayloadRef: "evb_0000000000000000000009",
        payloadDigest: `sha256:${"1".repeat(64)}`,
      });
      await io.checkpoint({
        engineStateSchema: "engine-state/v1",
        checkpointDigest: `sha256:${"2".repeat(64)}`,
        encryptedStateRef: "evb_000000000000000000000a",
      });
      return { result: { text: "done" } };
    };

    const worker = createAgentWorker({
      store: makeStore(),
      driveTurn: async () => ({ result: null }),
      concurrency: 1,
      attempts: {
        store: attemptStore,
        driveTurn,
        engine: ENGINE,
        onSealed: (h) => {
          observed.push(h);
          sealed.resolve(h);
        },
      },
    });
    worker.start();
    await sealed.promise;
    await worker.stop();

    // ONE append: both events AND the checkpoint travelled in the same
    // transaction, so they cannot tear apart.
    expect(attemptStore.appendAttemptBatch).toHaveBeenCalledTimes(1);
    const batch = (
      attemptStore.appendAttemptBatch as unknown as {
        mock: {
          calls: [
            { lease: unknown; events: unknown[]; checkpoint?: unknown },
          ][];
        };
      }
    ).mock.calls[0]![0];
    expect(batch.lease).toEqual(claimed.lease);
    expect(batch.checkpoint).toEqual({
      engineStateSchema: "engine-state/v1",
      checkpointDigest: `sha256:${"2".repeat(64)}`,
      encryptedStateRef: "evb_000000000000000000000a",
    });
    expect(
      (batch.events as { attemptSeq: number; eventType: string }[]).map((e) => [
        e.attemptSeq,
        e.eventType,
      ]),
    ).toEqual([
      [1, "context.frames_selected"],
      [2, "model.call_completed"],
    ]);
    for (const event of batch.events as { observedAt: string }[]) {
      expect(event.observedAt).toMatch(/T.*Z$/);
    }

    const seal = (
      attemptStore.sealAttempt as unknown as {
        mock: {
          calls: [
            {
              lease: unknown;
              terminalStatus: string;
              terminalEvent: {
                attemptSeq: number;
                eventType: string;
                payload: unknown;
              };
              sealerWorkerId: string;
              result: unknown;
            },
          ][];
        };
      }
    ).mock.calls[0]![0];
    expect(seal.lease).toEqual(claimed.lease);
    expect(seal.terminalStatus).toBe("completed");
    expect(seal.terminalEvent.eventType).toBe(TERMINAL_EVENT_TYPE);
    // Continues from what the store ACCEPTED (2), never from a local guess.
    expect(seal.terminalEvent.attemptSeq).toBe(3);
    expect(seal.terminalEvent.payload).toEqual({
      terminal_status: "completed",
    });
    expect(seal.result).toEqual({ text: "done" });
    expect(typeof seal.sealerWorkerId).toBe("string");

    // The seal's own handle carries the stable submission id of the obligation
    // the seal transaction already made durable.
    expect(observed).toEqual([handle]);
    expect(handle.submissionId).toBe(handle.grantPublicId);
  });

  it("starts attempt_seq at 1 for a successor that restored a prior attempt's checkpoint", async () => {
    const claimed = makeClaimedRunV2();
    claimed.v2 = {
      ...claimed.v2,
      attemptNumber: 2,
      restore: {
        attemptId: "attempt-prior",
        attemptPublicId: "arat_00000000000000000000aa",
        checkpointId: "checkpoint-prior",
        checkpointDigest: `sha256:${"3".repeat(64)}`,
        streamDigest: `sha256:${"4".repeat(64)}`,
        engineStateSchema: "engine-state/v1",
        encryptedStateRef: "evb_00000000000000000000bb",
        attemptSeq: 17,
        runSeq: 42,
      },
    };
    const sealed = deferred();
    const attemptStore = makeAttemptStore({
      claimNextRunV2: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      sealAttempt: vi.fn(async () => {
        sealed.resolve();
        return makeSealedHandle();
      }),
    });

    let sawRestore: unknown;
    const driveTurn: AttemptTurnDriver = async (run, io) => {
      sawRestore = run.v2.restore;
      io.onEvent({ eventType: "change.recorded", payload: { n: 1 } });
      return { result: null };
    };

    const worker = createAgentWorker({
      store: makeStore(),
      driveTurn: async () => ({ result: null }),
      concurrency: 1,
      attempts: { store: attemptStore, driveTurn, engine: ENGINE },
    });
    worker.start();
    await sealed.promise;
    await worker.stop();

    expect(sawRestore).toMatchObject({ attemptSeq: 17, runSeq: 42 });
    const batch = (
      attemptStore.appendAttemptBatch as unknown as {
        mock: { calls: [{ events: { attemptSeq: number }[] }][] };
      }
    ).mock.calls[0]![0];
    // The restored position travels on `restore`, NOT as a sequence offset:
    // attempt_seq identifies a position within THIS attempt.
    expect(batch.events.map((e) => e.attemptSeq)).toEqual([1]);
  });
});

describe("createAgentWorker — V2 event/checkpoint rollback", () => {
  it("replays a rolled-back batch byte-identically, sequences and observedAt untouched", async () => {
    const claimed = makeClaimedRunV2();
    const sealed = deferred();
    const batches: { attemptSeq: number; observedAt: string }[][] = [];
    let call = 0;
    const attemptStore = makeAttemptStore({
      claimNextRunV2: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      appendAttemptBatch: vi.fn(async (input) => {
        call += 1;
        if (call === 1) throw new Error("checkpoint insert failed");
        batches.push(
          input.events.map((e: { attemptSeq: number; observedAt: string }) => ({
            attemptSeq: e.attemptSeq,
            observedAt: e.observedAt,
          })),
        );
        return fakeAppendResult(input.events);
      }),
      sealAttempt: vi.fn(async () => {
        sealed.resolve();
        return makeSealedHandle();
      }),
    });

    let firstFailed = false;
    const driveTurn: AttemptTurnDriver = async (_run, io) => {
      io.onEvent({ eventType: "tool.call_completed", payload: { a: 1 } });
      try {
        await io.checkpoint({
          engineStateSchema: "engine-state/v1",
          checkpointDigest: `sha256:${"5".repeat(64)}`,
          encryptedStateRef: "evb_00000000000000000000cc",
        });
      } catch {
        firstFailed = true;
      }
      io.onEvent({ eventType: "tool.call_completed", payload: { a: 2 } });
      return { result: null };
    };

    const worker = createAgentWorker({
      store: makeStore(),
      driveTurn: async () => ({ result: null }),
      concurrency: 1,
      attempts: { store: attemptStore, driveTurn, engine: ENGINE },
    });
    worker.start();
    await sealed.promise;
    await worker.stop();

    expect(firstFailed).toBe(true);
    // The rolled-back event came back with its ORIGINAL sequence, alongside the
    // event buffered after the failure. Nothing was lost and nothing was
    // renumbered.
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((e) => e.attemptSeq)).toEqual([1, 2]);
    const seal = (
      attemptStore.sealAttempt as unknown as {
        mock: { calls: [{ terminalEvent: { attemptSeq: number } }][] };
      }
    ).mock.calls[0]![0];
    expect(seal.terminalEvent.attemptSeq).toBe(3);
  });

  it("refuses a checkpoint with nothing buffered instead of writing an unbound one", async () => {
    const claimed = makeClaimedRunV2();
    const sealed = deferred();
    const attemptStore = makeAttemptStore({
      claimNextRunV2: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      sealAttempt: vi.fn(async () => {
        sealed.resolve();
        return makeSealedHandle();
      }),
    });

    let refused: unknown;
    const driveTurn: AttemptTurnDriver = async (_run, io) => {
      try {
        await io.checkpoint({
          engineStateSchema: "engine-state/v1",
          checkpointDigest: `sha256:${"6".repeat(64)}`,
          encryptedStateRef: "evb_00000000000000000000dd",
        });
      } catch (err) {
        refused = err;
      }
      return { result: null };
    };

    const worker = createAgentWorker({
      store: makeStore(),
      driveTurn: async () => ({ result: null }),
      concurrency: 1,
      attempts: { store: attemptStore, driveTurn, engine: ENGINE },
    });
    worker.start();
    await sealed.promise;
    await worker.stop();

    expect(refused).toBeInstanceOf(RangeError);
    expect(attemptStore.appendAttemptBatch).not.toHaveBeenCalled();
  });

  it("rejects an emission that is neither inline nor an encrypted reference", async () => {
    const claimed = makeClaimedRunV2();
    const sealed = deferred();
    const attemptStore = makeAttemptStore({
      claimNextRunV2: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      sealAttempt: vi.fn(async () => {
        sealed.resolve();
        return makeSealedHandle();
      }),
    });

    const seen: unknown[] = [];
    const driveTurn: AttemptTurnDriver = async (_run, io) => {
      try {
        io.onEvent({ eventType: "change.recorded" });
      } catch (err) {
        seen.push(err);
      }
      try {
        io.onEvent({
          eventType: "change.recorded",
          payload: { a: 1 },
          encryptedPayloadRef: "evb_00000000000000000000ee",
        });
      } catch (err) {
        seen.push(err);
      }
      try {
        io.onEvent({
          eventType: "change.recorded",
          encryptedPayloadRef: "evb_00000000000000000000ee",
        });
      } catch (err) {
        seen.push(err);
      }
      return { result: null };
    };

    const worker = createAgentWorker({
      store: makeStore(),
      driveTurn: async () => ({ result: null }),
      concurrency: 1,
      attempts: { store: attemptStore, driveTurn, engine: ENGINE },
    });
    worker.start();
    await sealed.promise;
    await worker.stop();

    expect(seen).toHaveLength(3);
    for (const err of seen) expect(err).toBeInstanceOf(RangeError);
    expect(attemptStore.appendAttemptBatch).not.toHaveBeenCalled();
  });
});

describe("createAgentWorker — V2 fencing", () => {
  it("stops dead on a fenced lease renewal: no append, no checkpoint, and NO seal", async () => {
    const claimed = makeClaimedRunV2();
    const onError = vi.fn();
    const attemptStore = makeAttemptStore({
      claimNextRunV2: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      renewAttemptLease: vi.fn(async () => {
        throw fenceError(claimed.lease.attemptId);
      }),
    });

    const driveTurn: AttemptTurnDriver = (_run, io) =>
      new Promise((resolve) => {
        io.onEvent({ eventType: "model.call_completed", payload: { n: 1 } });
        io.signal.addEventListener("abort", () => {
          // Buffered after the fence: dropped, never appended.
          io.onEvent({ eventType: "model.call_completed", payload: { n: 2 } });
          resolve({ result: "ignored" });
        });
      });

    const worker = createAgentWorker({
      store: makeStore(),
      driveTurn: async () => ({ result: null }),
      concurrency: 1,
      leaseRenewIntervalMs: 10,
      onError,
      attempts: { store: attemptStore, driveTurn, engine: ENGINE },
    });
    worker.start();
    await new Promise((r) => setTimeout(r, 80));
    await worker.stop();

    expect(attemptStore.appendAttemptBatch).not.toHaveBeenCalled();
    expect(attemptStore.sealAttempt).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(RunLeaseFencedError), {
      runId: claimed.runId,
      phase: "attempt-lease-renew",
    });
  });

  it("stops dead when the append itself reports a fence, without sealing", async () => {
    const claimed = makeClaimedRunV2();
    const onError = vi.fn();
    const settled = deferred();
    const attemptStore = makeAttemptStore({
      claimNextRunV2: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      appendAttemptBatch: vi.fn(async () => {
        throw fenceError(claimed.lease.attemptId);
      }),
    });

    const driveTurn: AttemptTurnDriver = async (_run, io) => {
      io.onEvent({ eventType: "tool.call_completed", payload: { n: 1 } });
      try {
        await io.checkpoint({
          engineStateSchema: "engine-state/v1",
          checkpointDigest: `sha256:${"7".repeat(64)}`,
          encryptedStateRef: "evb_00000000000000000000ff",
        });
      } finally {
        settled.resolve();
      }
      return { result: "unreachable" };
    };

    const worker = createAgentWorker({
      store: makeStore(),
      driveTurn: async () => ({ result: null }),
      concurrency: 1,
      onError,
      attempts: { store: attemptStore, driveTurn, engine: ENGINE },
    });
    worker.start();
    await settled.promise;
    await settle();
    await worker.stop();

    expect(attemptStore.sealAttempt).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(RunLeaseFencedError), {
      runId: claimed.runId,
      phase: "attempt-append",
    });
  });

  it("stops dead when the live cancellation check reports a fence", async () => {
    const claimed = makeClaimedRunV2();
    const onError = vi.fn();
    const attemptStore = makeAttemptStore({
      claimNextRunV2: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      isAttemptCancelRequested: vi.fn(async () => {
        throw fenceError(claimed.lease.attemptId);
      }),
    });

    const driveTurn: AttemptTurnDriver = (_run, io) =>
      new Promise((resolve) => {
        io.signal.addEventListener("abort", () => resolve({ result: null }));
      });

    const worker = createAgentWorker({
      store: makeStore(),
      driveTurn: async () => ({ result: null }),
      concurrency: 1,
      cancelPollIntervalMs: 10,
      onError,
      attempts: { store: attemptStore, driveTurn, engine: ENGINE },
    });
    worker.start();
    await new Promise((r) => setTimeout(r, 80));
    await worker.stop();

    expect(attemptStore.sealAttempt).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(RunLeaseFencedError), {
      runId: claimed.runId,
      phase: "attempt-cancel-poll",
    });
  });
});

describe("createAgentWorker — V2 cancellation and denial", () => {
  it("seals a cancelled attempt as cancelled, flushing what it had first", async () => {
    const claimed = makeClaimedRunV2();
    const sealed = deferred();
    const attemptStore = makeAttemptStore({
      claimNextRunV2: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      isAttemptCancelRequested: vi.fn(async () => true),
      sealAttempt: vi.fn(async () => {
        sealed.resolve();
        return makeSealedHandle({ terminalStatus: "cancelled" });
      }),
    });

    const driveTurn: AttemptTurnDriver = (_run, io) =>
      new Promise((resolve) => {
        io.onEvent({ eventType: "tool.call_completed", payload: { n: 1 } });
        io.signal.addEventListener("abort", () =>
          resolve({ result: "ignored" }),
        );
      });

    const worker = createAgentWorker({
      store: makeStore(),
      driveTurn: async () => ({ result: null }),
      concurrency: 1,
      cancelPollIntervalMs: 10,
      attempts: { store: attemptStore, driveTurn, engine: ENGINE },
    });
    worker.start();
    await sealed.promise;
    await worker.stop();

    expect(attemptStore.appendAttemptBatch).toHaveBeenCalledTimes(1);
    const seal = (
      attemptStore.sealAttempt as unknown as {
        mock: {
          calls: [
            {
              terminalStatus: string;
              reasonCode?: string;
              terminalEvent: { attemptSeq: number; payload: unknown };
            },
          ][];
        };
      }
    ).mock.calls[0]![0];
    expect(seal.terminalStatus).toBe("cancelled");
    expect(seal.reasonCode).toBe("cancel_requested");
    expect(seal.terminalEvent.attemptSeq).toBe(2);
    expect(seal.terminalEvent.payload).toEqual({
      terminal_status: "cancelled",
      reason_code: "cancel_requested",
    });
  });

  it("seals a driver throw as failed with the message on the run row, not the event", async () => {
    const claimed = makeClaimedRunV2();
    const sealed = deferred();
    const attemptStore = makeAttemptStore({
      claimNextRunV2: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      sealAttempt: vi.fn(async () => {
        sealed.resolve();
        return makeSealedHandle({ terminalStatus: "failed" });
      }),
    });
    const driveTurn: AttemptTurnDriver = async () => {
      throw new Error("engine crashed on /etc/secret");
    };

    const worker = createAgentWorker({
      store: makeStore(),
      driveTurn: async () => ({ result: null }),
      concurrency: 1,
      attempts: { store: attemptStore, driveTurn, engine: ENGINE },
    });
    worker.start();
    await sealed.promise;
    await worker.stop();

    const seal = (
      attemptStore.sealAttempt as unknown as {
        mock: {
          calls: [
            {
              terminalStatus: string;
              error?: string;
              terminalEvent: { attemptSeq: number; payload: unknown };
            },
          ][];
        };
      }
    ).mock.calls[0]![0];
    expect(seal.terminalStatus).toBe("failed");
    expect(seal.error).toBe("engine crashed on /etc/secret");
    // The message never travels on the event — it can carry paths or source.
    expect(seal.terminalEvent.payload).toEqual({
      terminal_status: "failed",
      reason_code: "driver_error",
    });
    // Nothing was accepted, so the terminal event is the attempt's first.
    expect(seal.terminalEvent.attemptSeq).toBe(1);
  });

  it("seals a deliberate denial as denied", async () => {
    const claimed = makeClaimedRunV2();
    const sealed = deferred();
    const attemptStore = makeAttemptStore({
      claimNextRunV2: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      sealAttempt: vi.fn(async () => {
        sealed.resolve();
        return makeSealedHandle({ terminalStatus: "denied" });
      }),
    });
    const driveTurn: AttemptTurnDriver = async () => ({
      result: null,
      terminalStatus: "denied" as const,
      reasonCode: "capability_denied",
    });

    const worker = createAgentWorker({
      store: makeStore(),
      driveTurn: async () => ({ result: null }),
      concurrency: 1,
      attempts: { store: attemptStore, driveTurn, engine: ENGINE },
    });
    worker.start();
    await sealed.promise;
    await worker.stop();

    const seal = (
      attemptStore.sealAttempt as unknown as {
        mock: { calls: [{ terminalStatus: string; reasonCode?: string }][] };
      }
    ).mock.calls[0]![0];
    expect(seal.terminalStatus).toBe("denied");
    expect(seal.reasonCode).toBe("capability_denied");
  });
});

describe("createAgentWorker — V2 terminal failures", () => {
  it("treats a failed final commit as a driver error and still seals the attempt", async () => {
    const claimed = makeClaimedRunV2();
    const onError = vi.fn();
    const sealed = deferred();
    const attemptStore = makeAttemptStore({
      claimNextRunV2: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      appendAttemptBatch: vi.fn(async () => {
        throw new Error("append down at completion");
      }),
      sealAttempt: vi.fn(async () => {
        sealed.resolve();
        return makeSealedHandle({ terminalStatus: "failed" });
      }),
    });
    const driveTurn: AttemptTurnDriver = async (_run, io) => {
      io.onEvent({ eventType: "verification.completed", payload: { ok: 1 } });
      return { result: "would have completed" };
    };

    const worker = createAgentWorker({
      store: makeStore(),
      driveTurn: async () => ({ result: null }),
      concurrency: 1,
      onError,
      attempts: { store: attemptStore, driveTurn, engine: ENGINE },
    });
    worker.start();
    await sealed.promise;
    await worker.stop();

    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      runId: claimed.runId,
      phase: "attempt-final-commit",
    });
    const seal = (
      attemptStore.sealAttempt as unknown as {
        mock: {
          calls: [
            { terminalStatus: string; terminalEvent: { attemptSeq: number } },
          ][];
        };
      }
    ).mock.calls[0]![0];
    expect(seal.terminalStatus).toBe("failed");
    // The dropped batch never became durable, so the terminal event takes the
    // next sequence the STORE would accept — numbering past it would be a gap.
    expect(seal.terminalEvent.attemptSeq).toBe(1);
  });

  it("reports a failed seal via onError and leaves the attempt for the reclaimer", async () => {
    const claimed = makeClaimedRunV2();
    const boom = new Error("db down at seal");
    const reported = deferred<unknown>();
    const onError = vi.fn((err: unknown, ctx: { phase: string }) => {
      if (ctx.phase === "attempt-seal") reported.resolve(err);
    });
    const attemptStore = makeAttemptStore({
      claimNextRunV2: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
      sealAttempt: vi.fn(async () => {
        throw boom;
      }),
    });

    const worker = createAgentWorker({
      store: makeStore(),
      driveTurn: async () => ({ result: null }),
      concurrency: 1,
      onError,
      attempts: {
        store: attemptStore,
        driveTurn: async () => ({ result: "ok" }),
        engine: ENGINE,
      },
    });
    worker.start();
    const err = await reported.promise;
    await worker.stop();

    expect(err).toBe(boom);
  });

  it("swallows a throwing onSealed observer — it is telemetry, never the finalization path", async () => {
    const claimed = makeClaimedRunV2();
    const observed = deferred();
    const attemptStore = makeAttemptStore({
      claimNextRunV2: vi
        .fn()
        .mockResolvedValueOnce(claimed)
        .mockResolvedValue(null),
    });
    const onError = vi.fn();

    const worker = createAgentWorker({
      store: makeStore(),
      driveTurn: async () => ({ result: null }),
      concurrency: 1,
      onError,
      attempts: {
        store: attemptStore,
        driveTurn: async () => ({ result: "ok" }),
        engine: ENGINE,
        onSealed: () => {
          observed.resolve();
          throw new Error("observer is broken");
        },
      },
    });
    worker.start();
    await observed.promise;
    await settle();
    await worker.stop();

    expect(
      onError.mock.calls.filter(
        (c) => (c[1] as { phase: string }).phase === "attempt-seal",
      ),
    ).toHaveLength(0);
  });
});
