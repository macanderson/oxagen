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
    const result = await withTimeout(Promise.resolve("ok"), 5_000, null, "test");
    expect(result).toBe("ok");
  });

  it("rejects with AgentTimeoutError when the deadline fires first", async () => {
    vi.useFakeTimers();
    const slow = new Promise<string>(() => { /* never resolves */ });
    const raced = withTimeout(slow, 1_000, null, "slow op");
    vi.advanceTimersByTime(1_001);
    await expect(raced).rejects.toBeInstanceOf(AgentTimeoutError);
    const err = await raced.catch((e: unknown) => e) as AgentTimeoutError;
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
      withTimeout(Promise.resolve("should not reach"), 5_000, controller.signal, "short-circuit"),
    ).rejects.toBeInstanceOf(AgentTimeoutError);
  });

  it("rejects with AgentTimeoutError when signal fires before the deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const slow = new Promise<string>(() => { /* never resolves */ });
    const raced = withTimeout(slow, 10_000, controller.signal, "signal test");
    // Abort the signal (well before the 10s deadline).
    controller.abort();
    await expect(raced).rejects.toBeInstanceOf(AgentTimeoutError);
  });

  it("does NOT keep the Node.js process alive after the promise resolves", async () => {
    vi.useFakeTimers();
    // If the timer is not unref()ed this test would hang in some environments.
    // We verify the promise resolves cleanly — the absence of a hang IS the test.
    const resolved = withTimeout(Promise.resolve("fast"), 60_000, null, "fast op");
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

const RETRY_CFG = { perModelCallMs: 1_000, retry: { maxRetries: 2, backoffMs: 0 } };

describe("callModelWithTimeout", () => {
  it("passes through the value when the call completes before the deadline", async () => {
    const value = await callModelWithTimeout(
      async () => "ok",
      RETRY_CFG,
      { callId: "c1", model: "test/model" },
    );
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
            signal.addEventListener("abort", () => reject(new AgentTimeoutError("aborted", 1_000)), {
              once: true,
            });
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
    expect(logs.some((l) => l.includes("scope=model_call") && l.includes("action=retry"))).toBe(true);
  });

  it("throws after retries are exhausted", async () => {
    vi.useFakeTimers();
    const promise = callModelWithTimeout(
      (signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new AgentTimeoutError("aborted", 1_000)), {
            once: true,
          });
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
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
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
        runner.onProgress({ kind: "model_call_done", callId: `c${i}`, at: Date.now() });
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
          runner.signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(reason).resolves.toBe("inactivity");
    expect(logs.some((l) => l.includes("scope=turn") && l.includes("reason=inactivity"))).toBe(true);
  });

  it("does NOT abort a progressing turn even past the inactivity window", async () => {
    // Real timers, tiny window: 5 iterations spaced 30ms apart (total 150ms ≫
    // the 50ms window) — but each reports progress within the window, so the
    // inactivity guard keeps resetting and never fires.
    const runner = createTurnRunner({ turnInactivityMs: 50 });
    const reason = await runner.run(async () => {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 30));
        runner.onProgress({ kind: "tool_call_done", callId: `t${i}`, at: Date.now() });
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
          runner.signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    await vi.advanceTimersByTimeAsync(2_001);
    await expect(reason).resolves.toBe("hard_ceiling");
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
});

// ── toolTimeoutCategory ───────────────────────────────────────────────────────

describe("toolTimeoutCategory", () => {
  it('maps "bash" to "long"', () => {
    expect(toolTimeoutCategory("bash")).toBe("long");
  });

  it('maps standard tools to "standard"', () => {
    for (const name of ["read_file", "write_file", "edit_file", "glob", "grep", "list_dir", "code_graph"]) {
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
        execute: () => new Promise<string>(() => { /* never resolves */ }),
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
    expect((result as string)).toContain("timed out");
    expect((result as string)).toContain("tool:slow_tool");
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
    expect((result as string)).toContain("timed out");
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
        execute: () => new Promise<string>(() => { /* never resolves */ }),
      },
    };
    const wrapped = wrapToolsWithTimeout(tools);
    // @ts-expect-error — execute is callable
    const promise = wrapped.slow_tool.execute({}, {});
    vi.advanceTimersByTime(TIMEOUTS.toolMs + 1);
    await promise;
    const call = debugLogMock.mock.calls.find((c) => c[1] === "turn.tool-timeout");
    expect(call).toBeDefined();
    expect(call?.[0]).toBe("error");
    expect(call?.[2]).toMatchObject({ tool: "slow_tool", timeoutMs: TIMEOUTS.toolMs });
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
    const call = debugLogMock.mock.calls.find((c) => c[1] === "turn.tool-throw");
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
          inputSchema: z.object({ command: z.string(), timeout_ms: z.number().optional() }),
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
      const promise = wrapped.bash.execute({ command: "pytest", timeout_ms: 500_000 }, {});
      await vi.advanceTimersByTimeAsync(480_001);
      await expect(promise).resolves.toBe("done after 480s");
    } finally {
      vi.useRealTimers();
    }
  });
});
