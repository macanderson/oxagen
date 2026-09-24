import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `run.ts` starts the daemon; these tests drive only its stop path.
vi.mock("./daemon", () => ({ startDaemon: vi.fn() }));

import { STOP_GRACE_MS, stopWithin } from "./run";

describe("stopWithin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // #4012: `stop()` waits on the git lane, so a SIGTERM during a re-enroll
  // kept the old daemon alive past launchctl's bootstrap retries, and launchd
  // then removed the service the new bootstrap had loaded.
  it("exits 1 when stop has not finished within the grace period", () => {
    const exit = vi.fn();
    const log = vi.fn();
    stopWithin(() => new Promise<void>(() => undefined), 5_000, exit, log);
    vi.advanceTimersByTime(4_999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("5000 ms"));
  });

  it("exits 0 when stop finishes in time, and the timer does not fire later", async () => {
    const exit = vi.fn();
    stopWithin(() => Promise.resolve(), 5_000, exit, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(0);
    vi.advanceTimersByTime(10_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits 1 and logs the reason when stop fails", async () => {
    const exit = vi.fn();
    const log = vi.fn();
    stopWithin(() => Promise.reject(new Error("disk full")), 5_000, exit, log);
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    vi.advanceTimersByTime(10_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("keeps the grace period inside the service managers' 10 s kill timeouts", () => {
    expect(STOP_GRACE_MS).toBeLessThan(10_000);
  });
});
