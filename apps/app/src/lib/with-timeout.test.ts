/**
 * with-timeout.test.ts — unit tests for the page-read hang guard.
 *
 * Covers:
 *   - resolves with the work result when work settles before the timer
 *   - resolves with the fallback (and warns) when work never settles
 *   - propagates a rejection from work (rejections are the caller's business)
 *   - respects a custom timeoutMs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@oxagen/handlers/logger", () => ({ logger: mockLogger }));

import { withTimeout, PAGE_READ_TIMEOUT_MS } from "./with-timeout";

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the work result when work settles first", async () => {
    const result = await withTimeout(Promise.resolve("ok"), "fallback", "test");
    expect(result).toBe("ok");
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("resolves with the fallback when work never settles", async () => {
    const hung = new Promise<string>(() => {}); // never settles
    const pending = withTimeout(hung, "fallback", "test:hung");
    await vi.advanceTimersByTimeAsync(PAGE_READ_TIMEOUT_MS);
    await expect(pending).resolves.toBe("fallback");
    expect(mockLogger.warn).toHaveBeenCalledOnce();
    const call = mockLogger.warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.label).toBe("test:hung");
    expect(call.timeoutMs).toBe(PAGE_READ_TIMEOUT_MS);
  });

  it("does not fire the fallback warning when work wins the race", async () => {
    const result = await withTimeout(Promise.resolve(42), 0, "test:fast");
    expect(result).toBe(42);
    // Timer was cleared in the finally block — advancing past the deadline
    // must not produce a late warn.
    await vi.advanceTimersByTimeAsync(PAGE_READ_TIMEOUT_MS * 2);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("propagates a rejection from work", async () => {
    const err = new Error("backend down");
    await expect(
      withTimeout(Promise.reject(err), "fallback", "test:reject"),
    ).rejects.toBe(err);
  });

  it("respects a custom timeoutMs", async () => {
    const hung = new Promise<number>(() => {});
    const pending = withTimeout(hung, -1, "test:custom", 500);
    await vi.advanceTimersByTimeAsync(499);
    // Not yet — deadline is 500ms.
    expect(mockLogger.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(-1);
  });
});
