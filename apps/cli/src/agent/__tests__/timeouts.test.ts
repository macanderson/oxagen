/**
 * Unit tests for the CLI agent timeout utilities.
 *
 * These tests cover the pure functional helpers exported from ../timeouts.ts:
 *   - AgentTimeoutError construction and inheritance
 *   - withTimeout: resolves, rejects on deadline, respects existing abort signal,
 *     clears its timer on success
 *   - makeTurnController: fires from caller signal, fires on deadline
 *   - makeStallDetector: resets the window, fires after stallMs, stop() clears timer
 *   - wrapToolsWithTimeout: returns tool result normally, returns timeout string
 *     on deadline, passes through tools without execute untouched
 *   - toolTimeoutCategory: maps tool names to correct categories
 *
 * All timing-sensitive tests use fake timers (vitest's `vi.useFakeTimers`) to
 * avoid real wall-clock delays.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import type { ToolSet } from "ai";
// Spy on the debug log so we can assert a hung/failed tool actually gets recorded
// to cli.output (the "just agent messages, no exception data" bug).
const debugLogMock = vi.fn();
vi.mock("../../lib/debug-log.js", () => ({
  debugLog: (...args: unknown[]) => debugLogMock(...args),
}));
import * as timeoutsModule from "../timeouts.js";
import {
  AgentTimeoutError,
  TIMEOUTS,
  DEFAULT_TIMEOUTS,
  withTimeout,
  callModelWithTimeout,
  createTurnRunner,
  makeTurnController,
  makeStallDetector,
  wrapToolsWithTimeout,
  toolTimeoutCategory,
  toolWrapperTimeoutMs,
} from "../timeouts.js";

afterEach(() => {
  vi.useRealTimers();
});

// ── AgentTimeoutError ─────────────────────────────────────────────────────────

describe("AgentTimeoutError", () => {
  it("is an instance of Error", () => {
    const err = new AgentTimeoutError("test op", 5_000);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgentTimeoutError);
  });

  it('has name "AgentTimeoutError"', () => {
    const err = new AgentTimeoutError("tool:bash", 60_000);
    expect(err.name).toBe("AgentTimeoutError");
  });

  it("exposes the operation and timeoutMs", () => {
    const err = new AgentTimeoutError("LLM request", 90_000);
    expect(err.operation).toBe("LLM request");
    expect(err.timeoutMs).toBe(90_000);
  });

  it("includes a seconds figure in the message", () => {
    const err = new AgentTimeoutError("turn deadline", 120_000);
    expect(err.message).toContain("120s");
    expect(err.message).toContain("turn deadline");
  });

  it("includes the user-facing hint about retrying", () => {
    const err = new AgentTimeoutError("op", 5_000);
    expect(err.message.toLowerCase()).toContain("try again");
  });
});

// ── No turn-level wall-clock cap (Group 8, Bug 1) ─────────────────────────────

describe("no wall-clock turn cap", () => {
  it("removes the old TIMEOUTS.turnMs constant", () => {
    expect((TIMEOUTS as Record<string, unknown>)["turnMs"]).toBeUndefined();
  });

  it("removes the old AGENT_TURN_TIMEOUT_MS export", () => {
    expect(
      (timeoutsModule as Record<string, unknown>)["AGENT_TURN_TIMEOUT_MS"],
    ).toBeUndefined();
  });

  it("defaults the hard ceiling to disabled (undefined)", () => {
    expect(DEFAULT_TIMEOUTS.turnHardCeilingMs).toBeUndefined();
  });

  it("guards the turn by progress (inactivity), not total time", () => {
    // The default inactivity window is a *no-progress* window, not a turn cap.
    expect(DEFAULT_TIMEOUTS.turnInactivityMs).toBeGreaterThan(0);
    expect(DEFAULT_TIMEOUTS.perModelCallMs).toBeGreaterThan(0);
  });
});

// ── withTimeout ───────────────────────────────────────────────────────────────

describe("withTimeout", () => {
  it("passes through the resolved value when the promise settles before the deadline", async () => {
    const result = await withTimeout(
      Promise.resolve("ok"),
      5_000,
      null,
      "test",
    );
    expect(result).toBe("ok");
  });

  it("rejects with AgentTimeoutError when the deadline fires first", async () => {
    vi.useFakeTimers();
    const slow = new Promise<string>(() => {
      /* never resolves */
    });
    const raced = withTimeout(slow, 1_000, null, "slow op");
    vi.advanceTimersByTime(1_001);
    await expect(raced).rejects.toBeInstanceOf(AgentTimeoutError);
    const err = (await raced.catch((e: unknown) => e)) as AgentTimeoutError;
    expect(err.operation).toBe("slow op");
    expect(err.timeoutMs).toBe(1_000);
  });

  it("preserves rejection from the underlying promise (not a timeout)", async () => {
    const boom = Promise.reject(new Error("upstream"));
    await expect(withTimeout(boom, 5_000)).rejects.toThrow("upstream");
  });

  it("short-circuits immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      withTimeout(
        Promise.resolve("should not reach"),
        5_000,
        controller.signal,
        "short-circuit",
      ),
    ).rejects.toBeInstanceOf(AgentTimeoutError);
  });

  it("rejects with AgentTimeoutError when signal fires before the deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const slow = new Promise<string>(() => {
      /* never resolves */
    });
    const raced = withTimeout(slow, 10_000, controller.signal, "signal test");
    // Abort the signal (well before the 10s deadline).
    controller.abort();
    await expect(raced).rejects.toBeInstanceOf(AgentTimeoutError);
  });

  it("does NOT keep the Node.js process alive after the promise resolves", async () => {
    vi.useFakeTimers();
    // If the timer is not unref()ed this test would hang in some environments.
    // We verify the promise resolves cleanly — the absence of a hang IS the test.
    const resolved = withTimeout(
      Promise.resolve("fast"),
      60_000,
      null,
      "fast op",
    );
    await expect(resolved).resolves.toBe("fast");
  });
});

// ── makeTurnController ────────────────────────────────────────────────────────

describe("makeTurnController", () => {
  it("returns an AbortController whose signal is initially not aborted", () => {
    const ctrl = makeTurnController(null);
    expect(ctrl.signal.aborted).toBe(false);
  });

  it("aborts immediately when the caller signal is already aborted", () => {
    const callerCtrl = new AbortController();
    callerCtrl.abort("user cancelled");
    const ctrl = makeTurnController(callerCtrl.signal);
    expect(ctrl.signal.aborted).toBe(true);
  });

  it("aborts when the caller signal fires after construction", async () => {
    const callerCtrl = new AbortController();
    const ctrl = makeTurnController(callerCtrl.signal);
    expect(ctrl.signal.aborted).toBe(false);
    callerCtrl.abort("esc");
    // Allow microtask queue to drain.
    await Promise.resolve();
    expect(ctrl.signal.aborted).toBe(true);
  });

  it("does NOT impose a wall-clock deadline by default (no hard ceiling)", async () => {
    vi.useFakeTimers();
    const ctrl = makeTurnController(null);
    // Advance far past any old turn cap — the turn must NOT be aborted by a clock.
    vi.advanceTimersByTime(60 * 60 * 1000);
    await Promise.resolve();
    expect(ctrl.signal.aborted).toBe(false);
  });

  it("fires the optional hard ceiling only when explicitly set", async () => {
    vi.useFakeTimers();
    const ctrl = makeTurnController(null, { hardCeilingMs: 2_000 });
    expect(ctrl.signal.aborted).toBe(false);
    vi.advanceTimersByTime(2_001);
    await Promise.resolve();
    expect(ctrl.signal.aborted).toBe(true);
    expect(ctrl.signal.reason).toBeInstanceOf(AgentTimeoutError);
  });
});

// ── callModelWithTimeout (per-model-call timeout + retry) ──────────────────────

const RETRY_CFG = {
  perModelCallMs: 1_000,
  retry: { maxRetries: 2, backoffMs: 0 },
};

describe("callModelWithTimeout", () => {
  it("passes through the value when the call completes before the deadline", async () => {
    const value = await callModelWithTimeout(async () => "ok", RETRY_CFG, {
      callId: "c1",
      model: "test/model",
    });
    expect(value).toBe("ok");
  });

  it("aborts a hung call and retries, then succeeds — the turn continues", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    let attempts = 0;
    const promise = callModelWithTimeout(
      (signal: AbortSignal) => {
        attempts++;
        // First attempt hangs until aborted; second resolves immediately.
        if (attempts === 1) {
          return new Promise<string>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new AgentTimeoutError("aborted", 1_000)),
              {
                once: true,
              },
            );
          });
        }
        return Promise.resolve("recovered");
      },
      RETRY_CFG,
      { callId: "c2", model: "test/model", onLog: (l) => logs.push(l) },
    );
    // Trip the per-call deadline on attempt 1.
    await vi.advanceTimersByTimeAsync(1_001);
    const value = await promise;
    expect(value).toBe("recovered");
    expect(attempts).toBe(2);
    expect(
      logs.some(
        (l) => l.includes("scope=model_call") && l.includes("action=retry"),
      ),
    ).toBe(true);
  });

  it("throws after retries are exhausted", async () => {
    vi.useFakeTimers();
    const promise = callModelWithTimeout(
      (signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new AgentTimeoutError("aborted", 1_000)),
            {
              once: true,
            },
          );
        }),
      { perModelCallMs: 1_000, retry: { maxRetries: 1, backoffMs: 0 } },
      { callId: "c3", model: "test/model" },
    );
    const settled = promise.catch((e: unknown) => e);
    // Two attempts (initial + 1 retry), each tripping the 1s deadline.
    await vi.advanceTimersByTimeAsync(1_001);
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(settled).resolves.toBeInstanceOf(AgentTimeoutError);
  });

  it("does not retry when the outer signal aborts (user cancel)", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const promise = callModelWithTimeout(
      (signal: AbortSignal) => {
        attempts++;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        });
      },
      RETRY_CFG,
      { callId: "c4", model: "test/model" },
      controller.signal,
    );
    const settled = promise.catch((e: unknown) => e);
    controller.abort();
    await settled;
    expect(attempts).toBe(1);
  });
});

// ── createTurnRunner (progress-guarded turn; no wall-clock cap) ────────────────

describe("createTurnRunner", () => {
  it("runs a turn of 200 sequential model calls to completion — never aborted by a turn timer", async () => {
    // Real timers: 200 near-instant calls finish in ~0ms, far under the 300s
    // inactivity window. The whole point of Bug 1 — a turn with hundreds of
    // calls must not be capped by a turn timer.
    const runner = createTurnRunner({ turnInactivityMs: 300_000 });
    const reason = await runner.run(async () => {
      for (let i = 0; i < 200; i++) {
        await Promise.resolve();
        runner.onProgress({
          kind: "model_call_done",
          callId: `c${i}`,
          at: Date.now(),
        });
      }
    });
    expect(reason).toBe("completed");
  });

  it("aborts a stalled turn with reason=inactivity", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const runner = createTurnRunner(
      { turnInactivityMs: 5_000 },
      { onLog: (l) => logs.push(l) },
    );
    // Work that never completes and never reports progress.
    const reason = runner.run(
      () =>
        new Promise<void>((resolve) => {
          runner.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        }),
    );
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(reason).resolves.toBe("inactivity");
    expect(
      logs.some(
        (l) => l.includes("scope=turn") && l.includes("reason=inactivity"),
      ),
    ).toBe(true);
  });

  it("does NOT abort a progressing turn even past the inactivity window", async () => {
    // Fake timers: a real-timer version of this test (even with a wide 40ms/
    // 300ms margin) still flaked under full monorepo test concurrency, where
    // event-loop scheduling delays of multiple seconds were observed. Drive
    // the clock deterministically instead of racing wall-clock jitter — 5
    // steps of 200ms (1000ms total) each staying under the 300ms window.
    vi.useFakeTimers();
    const runner = createTurnRunner({ turnInactivityMs: 300 });
    const reason = await runner.run(async () => {
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(200);
        runner.onProgress({
          kind: "tool_call_done",
          callId: `t${i}`,
          at: Date.now(),
        });
      }
    });
    expect(reason).toBe("completed");
  });

  it("has no hard ceiling by default", async () => {
    vi.useFakeTimers();
    const runner = createTurnRunner({ turnInactivityMs: undefined });
    let done = false;
    const reason = runner.run(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // 1 hour of pure work
      done = true;
    });
    await vi.runAllTimersAsync();
    await expect(reason).resolves.toBe("completed");
    expect(done).toBe(true);
  });

  it("fires the optional hard ceiling when explicitly configured", async () => {
    vi.useFakeTimers();
    const runner = createTurnRunner({ turnHardCeilingMs: 2_000 });
    const reason = runner.run(
      () =>
        new Promise<void>((resolve) => {
          runner.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        }),
    );
    await vi.advanceTimersByTimeAsync(2_001);
    await expect(reason).resolves.toBe("hard_ceiling");
  });
});

// ── createTurnRunner — manual mode (subsumes the hand-rolled compositions) ─────
// The live surfaces (one-shot, pr-fix, sessions, planner) don't call run(): they
// pass `signal` to runTurn and drive the eagerly-armed guard via
// noteProgress / noteToolStart / noteToolEnd / stop. These cover that path.

describe("createTurnRunner — manual mode", () => {
  it("arms the inactivity guard eagerly and noteProgress() resets it", async () => {
    vi.useFakeTimers();
    const runner = createTurnRunner({ turnInactivityMs: 1_000 });
    // 900ms in, report progress: the window restarts from 0.
    await vi.advanceTimersByTimeAsync(900);
    runner.noteProgress();
    await vi.advanceTimersByTimeAsync(900);
    expect(runner.signal.aborted).toBe(false);
    // 1001ms silent since the last progress: the guard fires, controller aborts.
    await vi.advanceTimersByTimeAsync(1_001);
    expect(runner.signal.aborted).toBe(true);
    expect(runner.signal.reason).toBeInstanceOf(AgentTimeoutError);
    runner.stop();
  });

  it("defers the abort while a tool is in flight (default shouldDefer = tool count)", async () => {
    vi.useFakeTimers();
    const runner = createTurnRunner({ turnInactivityMs: 1_000 });
    runner.noteToolStart();
    // Two full windows elapse mid-tool: deferred both times.
    await vi.advanceTimersByTimeAsync(2_001);
    expect(runner.signal.aborted).toBe(false);
    // Tool returns; nothing else lands: the next expiry fires for real.
    runner.noteToolEnd();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(runner.signal.aborted).toBe(true);
    runner.stop();
  });

  it("wires a stall probe: a live CI wait extends the window instead of aborting", async () => {
    vi.useFakeTimers();
    const probe = vi.fn().mockResolvedValue(true);
    const runner = createTurnRunner(
      { turnInactivityMs: 1_000 },
      { stall: { probe } },
    );
    await vi.advanceTimersByTimeAsync(1_001);
    expect(probe).toHaveBeenCalledOnce();
    expect(runner.signal.aborted).toBe(false);
    runner.stop();
  });

  it("honours a custom shouldDefer (e.g. a fleet still executing)", async () => {
    vi.useFakeTimers();
    let fleetInFlight = true;
    const runner = createTurnRunner(
      { turnInactivityMs: 1_000 },
      { stall: { shouldDefer: () => fleetInFlight } },
    );
    await vi.advanceTimersByTimeAsync(2_001);
    expect(runner.signal.aborted).toBe(false);
    fleetInFlight = false;
    await vi.advanceTimersByTimeAsync(1_001);
    expect(runner.signal.aborted).toBe(true);
    runner.stop();
  });

  it("logs scope=turn reason=inactivity through onLog when the guard fires", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const runner = createTurnRunner(
      { turnInactivityMs: 1_000 },
      { onLog: (l) => logs.push(l) },
    );
    await vi.advanceTimersByTimeAsync(1_001);
    expect(runner.signal.aborted).toBe(true);
    expect(
      logs.some(
        (l) => l.includes("scope=turn") && l.includes("reason=inactivity"),
      ),
    ).toBe(true);
    runner.stop();
  });

  it("controller-only: no guard when turnInactivityMs is omitted, but the caller signal still chains", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const runner = createTurnRunner({}, { callerSignal: caller.signal });
    // No inactivity guard: an hour of silence never aborts it (planner path).
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(runner.signal.aborted).toBe(false);
    // The caller signal (Esc / Ctrl-C) still propagates.
    caller.abort("esc");
    await Promise.resolve();
    expect(runner.signal.aborted).toBe(true);
    // stop() is a safe no-op when no guard was armed.
    expect(() => runner.stop()).not.toThrow();
  });
});

// ── makeStallDetector ─────────────────────────────────────────────────────────

describe("makeStallDetector", () => {
  it("does NOT call onStall before stallMs has elapsed", () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    makeStallDetector(1_000, onStall);
    vi.advanceTimersByTime(999);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("calls onStall when no reset arrives within stallMs", () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    makeStallDetector(1_000, onStall);
    vi.advanceTimersByTime(1_001);
    expect(onStall).toHaveBeenCalledOnce();
  });

  it("resets the countdown on each reset() call", () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const { reset } = makeStallDetector(1_000, onStall);
    // Advance 900ms: no stall yet.
    vi.advanceTimersByTime(900);
    expect(onStall).not.toHaveBeenCalled();
    // Reset: the window restarts from 0.
    reset();
    // Advance another 900ms (total 1800ms but only 900ms since last reset): still no stall.
    vi.advanceTimersByTime(900);
    expect(onStall).not.toHaveBeenCalled();
    // Advance another 101ms (1001ms since last reset): stall fires.
    vi.advanceTimersByTime(101);
    expect(onStall).toHaveBeenCalledOnce();
  });

  it("stop() prevents onStall from firing", () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const { stop } = makeStallDetector(1_000, onStall);
    stop();
    vi.advanceTimersByTime(2_000);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("reset() after stop() is a no-op", () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const { reset, stop } = makeStallDetector(1_000, onStall);
    stop();
    reset(); // should do nothing
    vi.advanceTimersByTime(2_000);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("does not call onStall more than once even if stop() is called after it fires", () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const { stop } = makeStallDetector(500, onStall);
    vi.advanceTimersByTime(501);
    expect(onStall).toHaveBeenCalledOnce();
    stop();
    vi.advanceTimersByTime(1_000);
    // Still only one call.
    expect(onStall).toHaveBeenCalledOnce();
  });

  // ── shouldDefer / probe escape hatches ──────────────────────────────────────

  it("defers instead of firing while shouldDefer() is true (in-flight tool)", () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    let inFlight = true;
    makeStallDetector(1_000, onStall, { shouldDefer: () => inFlight });
    // Two full windows elapse mid-tool: deferred both times.
    vi.advanceTimersByTime(2_001);
    expect(onStall).not.toHaveBeenCalled();
    // Tool returns but nothing else lands: next expiry fires for real.
    inFlight = false;
    vi.advanceTimersByTime(1_001);
    expect(onStall).toHaveBeenCalledOnce();
  });

  it("extends the window when the probe confirms a live CI wait", async () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const probe = vi.fn().mockResolvedValue(true);
    makeStallDetector(1_000, onStall, { probe });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(probe).toHaveBeenCalledOnce();
    expect(onStall).not.toHaveBeenCalled();
    // Extended: another full silent window triggers another probe, not a fire.
    await vi.advanceTimersByTimeAsync(1_001);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("fires when the probe says the wait is over (or fails)", async () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    makeStallDetector(1_000, onStall, { probe: () => Promise.resolve(false) });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(onStall).toHaveBeenCalledOnce();

    const onStall2 = vi.fn();
    makeStallDetector(1_000, onStall2, {
      probe: () => Promise.reject(new Error("gh down")),
    });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(onStall2).toHaveBeenCalledOnce();
  });

  it("caps cumulative probe extensions at probeCapMs, then fires without probing", async () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const probe = vi.fn().mockResolvedValue(true);
    // Cap allows exactly two 1s extensions.
    makeStallDetector(1_000, onStall, { probe, probeCapMs: 2_000 });
    await vi.advanceTimersByTimeAsync(1_001); // extend #1 (1s accumulated)
    await vi.advanceTimersByTimeAsync(1_001); // extend #2 (2s accumulated = cap)
    expect(onStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_001); // cap reached: fire, no probe
    expect(probe).toHaveBeenCalledTimes(2);
    expect(onStall).toHaveBeenCalledOnce();
  });

  it("reset() zeroes the extension accumulator (cap is per silent stretch)", async () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    const probe = vi.fn().mockResolvedValue(true);
    const { reset } = makeStallDetector(1_000, onStall, {
      probe,
      probeCapMs: 1_500,
    });
    await vi.advanceTimersByTimeAsync(1_001); // extend #1 (1s of 1.5s cap)
    reset(); // real progress: accumulator back to 0
    await vi.advanceTimersByTimeAsync(1_001); // extend again — budget is fresh
    expect(onStall).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("discards a stale probe verdict when reset() lands while probing", async () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    let resolveProbe: ((v: boolean) => void) | null = null;
    const probe = (): Promise<boolean> =>
      new Promise<boolean>((res) => {
        resolveProbe = res;
      });
    const { reset } = makeStallDetector(1_000, onStall, { probe });
    await vi.advanceTimersByTimeAsync(1_001); // probe starts, hangs
    reset(); // real progress lands mid-probe
    resolveProbe!(false); // stale "abort" verdict must be ignored
    await vi.advanceTimersByTimeAsync(0);
    expect(onStall).not.toHaveBeenCalled();
  });

  it("stop() while probing suppresses the verdict entirely", async () => {
    vi.useFakeTimers();
    const onStall = vi.fn();
    let resolveProbe: ((v: boolean) => void) | null = null;
    const probe = (): Promise<boolean> =>
      new Promise<boolean>((res) => {
        resolveProbe = res;
      });
    const { stop } = makeStallDetector(1_000, onStall, { probe });
    await vi.advanceTimersByTimeAsync(1_001);
    stop();
    resolveProbe!(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(onStall).not.toHaveBeenCalled();
  });
});

// ── env-tunable resolvers ─────────────────────────────────────────────────────

describe("resolveTurnInactivityMs / resolveCiWaitCapMs", () => {
  afterEach(() => {
    delete process.env["OXAGEN_TURN_INACTIVITY_MS"];
    delete process.env["OXAGEN_CI_WAIT_CAP_MS"];
  });

  it("defaults to DEFAULT_TIMEOUTS.turnInactivityMs and TIMEOUTS.ciWaitCapMs", () => {
    expect(timeoutsModule.resolveTurnInactivityMs()).toBe(
      DEFAULT_TIMEOUTS.turnInactivityMs,
    );
    expect(timeoutsModule.resolveCiWaitCapMs()).toBe(TIMEOUTS.ciWaitCapMs);
    expect(TIMEOUTS.ciWaitCapMs).toBe(2 * 60 * 60 * 1_000);
  });

  it("honors positive env overrides and ignores junk", () => {
    process.env["OXAGEN_TURN_INACTIVITY_MS"] = "600000";
    process.env["OXAGEN_CI_WAIT_CAP_MS"] = "3600000";
    expect(timeoutsModule.resolveTurnInactivityMs()).toBe(600_000);
    expect(timeoutsModule.resolveCiWaitCapMs()).toBe(3_600_000);

    process.env["OXAGEN_TURN_INACTIVITY_MS"] = "not-a-number";
    process.env["OXAGEN_CI_WAIT_CAP_MS"] = "-5";
    expect(timeoutsModule.resolveTurnInactivityMs()).toBe(
      DEFAULT_TIMEOUTS.turnInactivityMs,
    );
    expect(timeoutsModule.resolveCiWaitCapMs()).toBe(TIMEOUTS.ciWaitCapMs);
  });
});

// ── toolTimeoutCategory ───────────────────────────────────────────────────────

describe("toolTimeoutCategory", () => {
  it('maps "bash" to "long"', () => {
    expect(toolTimeoutCategory("bash")).toBe("long");
  });

  it('maps standard tools to "standard"', () => {
    for (const name of [
      "read_file",
      "write_file",
      "edit_file",
      "glob",
      "grep",
      "list_dir",
      "code_graph",
    ]) {
      expect(toolTimeoutCategory(name)).toBe("standard");
    }
  });

  it('maps unknown tool names to "standard" as a safe default', () => {
    expect(toolTimeoutCategory("some_mcp_tool")).toBe("standard");
  });
});

// ── wrapToolsWithTimeout ──────────────────────────────────────────────────────

describe("wrapToolsWithTimeout", () => {
  it("passes through a tool result that arrives before the deadline", async () => {
    const tools: ToolSet = {
      fast_tool: {
        description: "fast",
        inputSchema: z.object({}),
        execute: async () => "result",
      },
    };
    const wrapped = wrapToolsWithTimeout(tools);
    // @ts-expect-error — execute is callable; TS types it as `unknown`
    const result = await wrapped.fast_tool.execute({}, {});
    expect(result).toBe("result");
  });

  it("returns an AgentTimeoutError message string when the tool exceeds the deadline", async () => {
    vi.useFakeTimers();
    const tools: ToolSet = {
      slow_tool: {
        description: "slow",
        inputSchema: z.object({}),
        execute: () =>
          new Promise<string>(() => {
            /* never resolves */
          }),
      },
    };
    // Override toolMs for the test (wrapToolsWithTimeout uses TIMEOUTS.toolMs by default).
    // We cannot easily override the constant, so we use a direct withTimeout
    // at a very short deadline by testing the execute on a sub-ms-capped promise.
    //
    // Instead, directly verify the timeout wrapper logic with a real-time spy:
    const wrapped = wrapToolsWithTimeout(tools);
    // @ts-expect-error — execute is callable
    const promise = wrapped.slow_tool.execute({}, {});
    // Advance past the standard tool timeout (60s).
    vi.advanceTimersByTime(TIMEOUTS.toolMs + 1);
    const result = await promise;
    // The result must be a string (the tool-result form of the timeout error).
    expect(typeof result).toBe("string");
    expect(result as string).toContain("timed out");
    expect(result as string).toContain("tool:slow_tool");
  });

  it("passes through tools without an execute function unchanged", () => {
    const tools: ToolSet = {
      schema_only: {
        description: "no execute",
        inputSchema: z.object({}),
      },
    };
    const wrapped = wrapToolsWithTimeout(tools);
    expect(wrapped["schema_only"]?.execute).toBeUndefined();
  });

  it("short-circuits immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const tools: ToolSet = {
      my_tool: {
        description: "tool",
        inputSchema: z.object({}),
        execute: async () => "should not run",
      },
    };
    const wrapped = wrapToolsWithTimeout(tools, controller.signal);
    // @ts-expect-error — execute is callable
    const result = await wrapped.my_tool.execute({}, {});
    expect(typeof result).toBe("string");
    expect(result as string).toContain("timed out");
    // The real execute must not have been called.
    expect(result as string).not.toBe("should not run");
  });

  it("logs a turn.tool-timeout error entry when a tool hangs past its deadline", async () => {
    vi.useFakeTimers();
    debugLogMock.mockClear();
    const tools: ToolSet = {
      slow_tool: {
        description: "slow",
        inputSchema: z.object({}),
        execute: () =>
          new Promise<string>(() => {
            /* never resolves */
          }),
      },
    };
    const wrapped = wrapToolsWithTimeout(tools);
    // @ts-expect-error — execute is callable
    const promise = wrapped.slow_tool.execute({}, {});
    vi.advanceTimersByTime(TIMEOUTS.toolMs + 1);
    await promise;
    const call = debugLogMock.mock.calls.find(
      (c) => c[1] === "turn.tool-timeout",
    );
    expect(call).toBeDefined();
    expect(call?.[0]).toBe("error");
    expect(call?.[2]).toMatchObject({
      tool: "slow_tool",
      timeoutMs: TIMEOUTS.toolMs,
    });
  });

  it("logs a turn.tool-throw error entry (with the exception) when a tool throws", async () => {
    debugLogMock.mockClear();
    const boom = new Error("kaboom");
    const tools: ToolSet = {
      bad_tool: {
        description: "bad",
        inputSchema: z.object({}),
        execute: async () => {
          throw boom;
        },
      },
    };
    const wrapped = wrapToolsWithTimeout(tools);
    // @ts-expect-error — execute is callable
    await expect(wrapped.bad_tool.execute({}, {})).rejects.toThrow("kaboom");
    const call = debugLogMock.mock.calls.find(
      (c) => c[1] === "turn.tool-throw",
    );
    expect(call).toBeDefined();
    expect(call?.[0]).toBe("error");
    expect(call?.[2]).toMatchObject({ tool: "bad_tool", error: boom });
  });

  it("preserves other tool properties (description, inputSchema)", () => {
    const tools: ToolSet = {
      t: {
        description: "my description",
        inputSchema: z.object({ x: z.string().optional() }),
        execute: async () => "ok",
      },
    };
    const wrapped = wrapToolsWithTimeout(tools);
    expect(wrapped["t"]?.description).toBe("my description");
    expect(wrapped["t"]?.inputSchema).toEqual(tools["t"]?.inputSchema);
  });
});

describe("toolWrapperTimeoutMs", () => {
  it("gives standard tools the fixed standard deadline", () => {
    expect(toolWrapperTimeoutMs("read_file", {})).toBe(TIMEOUTS.toolMs);
    expect(toolWrapperTimeoutMs("grep", null)).toBe(TIMEOUTS.toolMs);
  });

  it("honors bash's declared timeout_ms plus the grace margin", () => {
    expect(toolWrapperTimeoutMs("bash", { timeout_ms: 500_000 })).toBe(
      500_000 + TIMEOUTS.toolGraceMs,
    );
  });

  it("uses bash's schema default when no timeout_ms is declared", () => {
    expect(toolWrapperTimeoutMs("bash", {})).toBe(
      TIMEOUTS.bashDefaultMs + TIMEOUTS.toolGraceMs,
    );
  });

  it("caps a declared timeout_ms at bash's schema max", () => {
    expect(toolWrapperTimeoutMs("bash", { timeout_ms: 9_999_999 })).toBe(
      TIMEOUTS.bashMaxMs + TIMEOUTS.toolGraceMs,
    );
  });

  it("never fires before the tool's own timeout: a bash call declaring 500s survives 240s", async () => {
    vi.useFakeTimers();
    try {
      const tools: ToolSet = {
        bash: {
          description: "bash",
          inputSchema: z.object({
            command: z.string(),
            timeout_ms: z.number().optional(),
          }),
          // Resolves at 480s — inside its declared 500s budget, but past the
          // old fixed 240s wrapper that used to kill it.
          execute: () =>
            new Promise<string>((resolve) => {
              setTimeout(() => resolve("done after 480s"), 480_000);
            }),
        },
      };
      const wrapped = wrapToolsWithTimeout(tools);
      // @ts-expect-error — execute is callable
      const promise = wrapped.bash.execute(
        { command: "pytest", timeout_ms: 500_000 },
        {},
      );
      await vi.advanceTimersByTimeAsync(480_001);
      await expect(promise).resolves.toBe("done after 480s");
    } finally {
      vi.useRealTimers();
    }
  });
});
