import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted — use vi.hoisted so the mock fns are declared before the
// factory runs, and the factory returns a plain object (not the real driver
// `Session` type) so it satisfies `session()`'s real return type loosely,
// mirroring migrate.test.ts's own `./client` mock convention.
const { mockNeoRun, mockNeoClose } = vi.hoisted(() => ({
  mockNeoRun: vi.fn(),
  mockNeoClose: vi.fn(),
}));

vi.mock("../client", () => ({
  session: () => ({ run: mockNeoRun, close: mockNeoClose }),
}));

import { sweepExpiredFileLocks } from "./sweep-file-locks";

function mockRecord(fields: Record<string, unknown>) {
  return { get: (key: string) => fields[key] };
}

describe("sweepExpiredFileLocks", () => {
  beforeEach(() => {
    mockNeoRun.mockReset();
    mockNeoRun.mockResolvedValue({ records: [mockRecord({ sweptCount: 0 })] });
    mockNeoClose.mockReset();
    mockNeoClose.mockResolvedValue(undefined);
  });

  it("matches HOLDS_LOCK edges of ANY org whose expiresAt is before `now`", async () => {
    await sweepExpiredFileLocks(1_000);
    const cypher = mockNeoRun.mock.calls[0]![0] as string;
    expect(cypher).toContain("HOLDS_LOCK");
    expect(cypher).toContain("l.expiresAt < $now");
    // No orgId filter — a system-wide sweep is intentionally cross-tenant.
    expect(cypher).not.toContain("orgId");
    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    expect(params).toEqual({ now: 1_000 });
  });

  it("defaults `now` to Date.now() when omitted", async () => {
    const before = Date.now();
    await sweepExpiredFileLocks();
    const after = Date.now();
    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    expect(params.now as number).toBeGreaterThanOrEqual(before);
    expect(params.now as number).toBeLessThanOrEqual(after);
  });

  it("returns the swept edge count", async () => {
    mockNeoRun.mockResolvedValue({ records: [mockRecord({ sweptCount: 4 })] });
    const result = await sweepExpiredFileLocks(1_000);
    expect(result.sweptCount).toBe(4);
  });

  it("returns sweptCount:0 when nothing is expired", async () => {
    mockNeoRun.mockResolvedValue({ records: [mockRecord({ sweptCount: 0 })] });
    const result = await sweepExpiredFileLocks(1_000);
    expect(result.sweptCount).toBe(0);
  });

  it("always closes the session, even on failure", async () => {
    mockNeoRun.mockRejectedValue(new Error("neo4j down"));
    await expect(sweepExpiredFileLocks(1_000)).rejects.toThrow("neo4j down");
    expect(mockNeoClose).toHaveBeenCalledTimes(1);
  });
});
