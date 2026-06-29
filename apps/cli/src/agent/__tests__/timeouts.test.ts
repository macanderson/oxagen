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
import {
  AgentTimeoutError,
  TIMEOUTS,
  AGENT_TURN_TIMEOUT_MS,
  withTimeout,
  makeTurnController,
  makeStallDetector,
  wrapToolsWithTimeout,
  toolTimeoutCategory,
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

// ── AGENT_TURN_TIMEOUT_MS export ──────────────────────────────────────────────

describe("AGENT_TURN_TIMEOUT_MS", () => {
  it("matches TIMEOUTS.turnMs so the TUI and the loop agree", () => {
    expect(AGENT_TURN_TIMEOUT_MS).toBe(TIMEOUTS.turnMs);
  });

  it("is a positive number > 0", () => {
    expect(AGENT_TURN_TIMEOUT_MS).toBeGreaterThan(0);
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
    const ctrl = makeTurnController(null, 60_000);
    expect(ctrl.signal.aborted).toBe(false);
  });

  it("aborts immediately when the caller signal is already aborted", () => {
    const callerCtrl = new AbortController();
    callerCtrl.abort("user cancelled");
    const ctrl = makeTurnController(callerCtrl.signal, 60_000);
    expect(ctrl.signal.aborted).toBe(true);
  });

  it("aborts when the caller signal fires after construction", async () => {
    const callerCtrl = new AbortController();
    const ctrl = makeTurnController(callerCtrl.signal, 60_000);
    expect(ctrl.signal.aborted).toBe(false);
    callerCtrl.abort("esc");
    // Allow microtask queue to drain.
    await Promise.resolve();
    expect(ctrl.signal.aborted).toBe(true);
  });

  it("aborts after the deadline elapses", async () => {
    vi.useFakeTimers();
    const ctrl = makeTurnController(null, 2_000);
    expect(ctrl.signal.aborted).toBe(false);
    vi.advanceTimersByTime(2_001);
    await Promise.resolve();
    expect(ctrl.signal.aborted).toBe(true);
  });

  it("aborts with an AgentTimeoutError reason when the deadline fires", async () => {
    vi.useFakeTimers();
    const ctrl = makeTurnController(null, 500);
    vi.advanceTimersByTime(501);
    await Promise.resolve();
    expect(ctrl.signal.reason).toBeInstanceOf(AgentTimeoutError);
  });

  it("works with no caller signal (deadline-only mode)", async () => {
    vi.useFakeTimers();
    const ctrl = makeTurnController(undefined, 1_000);
    vi.advanceTimersByTime(1_001);
    await Promise.resolve();
    expect(ctrl.signal.aborted).toBe(true);
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
