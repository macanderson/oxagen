/**
 * safe-query.test.ts — unit tests for safeQuery utility.
 *
 * Covers:
 *   - returns the query result on success
 *   - returns the fallback when the query throws
 *   - logs the error via logger.error on failure
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@oxagen/handlers/logger", () => ({ logger: mockLogger }));

import { safeQuery } from "./safe-query";

describe("safeQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the resolved value of the query fn on success", async () => {
    const result = await safeQuery(
      () => Promise.resolve([{ id: "row-1" }]),
      [],
    );
    expect(result).toEqual([{ id: "row-1" }]);
  });

  it("returns the fallback when the query fn throws", async () => {
    const result = await safeQuery(
      () => Promise.reject(new Error("DB timeout")),
      [] as unknown[],
    );
    expect(result).toEqual([]);
  });

  it("calls logger.error with the error when the query fn throws", async () => {
    const err = new Error("connection lost");
    await safeQuery(() => Promise.reject(err), null);
    expect(mockLogger.error).toHaveBeenCalledOnce();
    const call = mockLogger.error.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.err).toBe(err);
  });

  it("works with a non-array fallback (null)", async () => {
    const result = await safeQuery(
      () => Promise.reject(new Error("boom")),
      null as null,
    );
    expect(result).toBeNull();
  });

  it("returns the correct value for a synchronous-style resolved promise", async () => {
    const result = await safeQuery(() => Promise.resolve(42), 0);
    expect(result).toBe(42);
  });
});
