import { describe, expect, it, vi, afterEach } from "vitest";
import {
  decideSweepAction,
  startLeaseRenewal,
  MAX_ATTEMPTS,
  LEASE_RENEW_INTERVAL_MS,
} from "./lease";

describe("decideSweepAction", () => {
  it("requeues below the attempt cap", () => {
    expect(decideSweepAction(0)).toBe("requeue");
    expect(decideSweepAction(1)).toBe("requeue");
    expect(decideSweepAction(MAX_ATTEMPTS - 1)).toBe("requeue");
  });

  it("fails at and above the attempt cap", () => {
    expect(decideSweepAction(MAX_ATTEMPTS)).toBe("fail");
    expect(decideSweepAction(MAX_ATTEMPTS + 5)).toBe("fail");
  });

  it("honours an explicit cap", () => {
    expect(decideSweepAction(1, 1)).toBe("fail");
    expect(decideSweepAction(0, 1)).toBe("requeue");
  });
});

describe("startLeaseRenewal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes the renew callback on each interval tick until stopped", async () => {
    vi.useFakeTimers();
    const renew = vi.fn().mockResolvedValue(undefined);

    const stop = startLeaseRenewal(renew, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(3500);
    expect(renew).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(renew).toHaveBeenCalledTimes(3);
  });

  it("reports renewal failures via onError without throwing", async () => {
    vi.useFakeTimers();
    const boom = new Error("db down");
    const renew = vi.fn().mockRejectedValue(boom);
    const onError = vi.fn();

    const stop = startLeaseRenewal(renew, { intervalMs: 1000, onError });
    await vi.advanceTimersByTimeAsync(2100);
    stop();

    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("defaults to a cadence well under half the lease window", () => {
    // 10-min lease, renew every 4 min → one missed tick still leaves slack.
    expect(LEASE_RENEW_INTERVAL_MS).toBeLessThan((600 * 1000) / 2);
  });
});
