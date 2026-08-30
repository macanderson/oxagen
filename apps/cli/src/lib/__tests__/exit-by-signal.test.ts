/**
 * Unit coverage for exit-by-signal.ts — the terminate-after-cleanup path the
 * REPL and Mission Control signal handlers use INSTEAD of `process.exit()`.
 * The contract under test: drop the signal's JS listeners (restoring default
 * disposition), re-raise the same signal at our own pid, and only ever fall
 * back to `process.exit` when the kill throws or the re-raise is swallowed
 * (unref'd 500ms net). `process.exit` from a signal handler is what aborted
 * the CLI on 2026-07-09 (libc++abi "mutex lock failed" — exit()-time static
 * destructors vs live duckdb/onnxruntime worker threads), so a regression
 * here reintroduces a hard crash on every external SIGTERM (e.g. `pnpm kill`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { exitBySignal, signalExitCode } from "../exit-by-signal.js";

// Every spy is a no-op double: really removing vitest's own listeners or
// re-raising SIGINT at the worker would kill the test run itself.
const spyRemoveAll = () =>
  vi.spyOn(process, "removeAllListeners").mockReturnValue(process);
const spyKill = () => vi.spyOn(process, "kill").mockReturnValue(true);
const spyExit = () =>
  vi.spyOn(process, "exit").mockReturnValue(undefined as never);
let removeAll: ReturnType<typeof spyRemoveAll>;
let kill: ReturnType<typeof spyKill>;
let exit: ReturnType<typeof spyExit>;

beforeEach(() => {
  vi.useFakeTimers();
  removeAll = spyRemoveAll();
  kill = spyKill();
  exit = spyExit();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("signalExitCode", () => {
  it("maps to the conventional 128+n codes", () => {
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGTERM")).toBe(143);
  });
});

describe("exitBySignal", () => {
  it("drops the signal's listeners then re-raises it at our own pid", () => {
    exitBySignal("SIGTERM");
    expect(removeAll).toHaveBeenCalledWith("SIGTERM");
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
    // The whole point: no exit()-time destructor walk on the happy path.
    expect(exit).not.toHaveBeenCalled();
  });

  it("re-raises the SAME signal it was given", () => {
    exitBySignal("SIGINT");
    expect(removeAll).toHaveBeenCalledWith("SIGINT");
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT");
  });

  it("falls back to process.exit(128+n) when the re-raise throws", () => {
    kill.mockImplementation(() => {
      throw new Error("kill unsupported");
    });
    exitBySignal("SIGTERM");
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("hard-exits via the 500ms net if the re-raised signal is swallowed", () => {
    exitBySignal("SIGINT");
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(exit).toHaveBeenCalledWith(130);
  });
});
