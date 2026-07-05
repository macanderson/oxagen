import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../tenant", () => ({
  scopedSession: vi.fn().mockReturnValue({
    run: vi.fn().mockResolvedValue({ records: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { scopedSession } from "../tenant";
import { releaseFileLock, releaseFileLocksByExecution } from "./release-file-lock";

const mockScopedSession = vi.mocked(scopedSession);

function mockRecord(fields: Record<string, unknown>) {
  return { get: (key: string) => fields[key] };
}

describe("releaseFileLock", () => {
  let mockNeoRun: ReturnType<typeof vi.fn>;
  let mockNeoClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockNeoRun = vi.fn().mockResolvedValue({ records: [mockRecord({ deletedCount: 1 })] });
    mockNeoClose = vi.fn().mockResolvedValue(undefined);
    mockScopedSession.mockReturnValue({ run: mockNeoRun, close: mockNeoClose });
  });

  it("matches the HOLDS_LOCK edge by BOTH lockId and the releasing agent's id (agent can only release its own lock)", async () => {
    await releaseFileLock({ lockId: "lock-1", agentId: "agent-a" });
    const cypher = mockNeoRun.mock.calls[0]![0] as string;
    expect(cypher).toContain("Agent {id: $agentId, orgId: $orgId}");
    expect(cypher).toContain("HOLDS_LOCK {lockId: $lockId}");
    expect(cypher).toContain("DELETE");
    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    expect(params).toEqual({ lockId: "lock-1", agentId: "agent-a" });
  });

  it("returns released:true when an edge was deleted", async () => {
    mockNeoRun.mockResolvedValue({ records: [mockRecord({ deletedCount: 1 })] });
    const result = await releaseFileLock({ lockId: "lock-1", agentId: "agent-a" });
    expect(result.released).toBe(true);
  });

  it("returns released:false (not an error) when no matching lock exists — idempotent release", async () => {
    mockNeoRun.mockResolvedValue({ records: [mockRecord({ deletedCount: 0 })] });
    const result = await releaseFileLock({ lockId: "lock-missing", agentId: "agent-a" });
    expect(result.released).toBe(false);
  });

  it("always closes the session, even on failure", async () => {
    mockNeoRun.mockRejectedValue(new Error("neo4j down"));
    await expect(releaseFileLock({ lockId: "lock-1", agentId: "agent-a" })).rejects.toThrow("neo4j down");
    expect(mockNeoClose).toHaveBeenCalledTimes(1);
  });
});

describe("releaseFileLocksByExecution", () => {
  let mockNeoRun: ReturnType<typeof vi.fn>;
  let mockNeoClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockNeoRun = vi.fn().mockResolvedValue({ records: [mockRecord({ deletedCount: 3 })] });
    mockNeoClose = vi.fn().mockResolvedValue(undefined);
    mockScopedSession.mockReturnValue({ run: mockNeoRun, close: mockNeoClose });
  });

  it("matches every HOLDS_LOCK edge stamped with the given executionId, regardless of holder", async () => {
    await releaseFileLocksByExecution({ executionId: "turn_a1" });
    const cypher = mockNeoRun.mock.calls[0]![0] as string;
    expect(cypher).toContain("HOLDS_LOCK {executionId: $executionId}");
    expect(cypher).toContain("DELETE");
    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    expect(params).toEqual({ executionId: "turn_a1" });
  });

  it("returns the total releasedCount across all matched edges (batch release)", async () => {
    mockNeoRun.mockResolvedValue({ records: [mockRecord({ deletedCount: 3 })] });
    const result = await releaseFileLocksByExecution({ executionId: "turn_a1" });
    expect(result.releasedCount).toBe(3);
  });

  it("returns releasedCount:0 when the turn holds no locks — a turn never leaks locks, but also never errors", async () => {
    mockNeoRun.mockResolvedValue({ records: [mockRecord({ deletedCount: 0 })] });
    const result = await releaseFileLocksByExecution({ executionId: "turn_empty" });
    expect(result.releasedCount).toBe(0);
  });

  it("always closes the session, even on failure", async () => {
    mockNeoRun.mockRejectedValue(new Error("neo4j down"));
    await expect(releaseFileLocksByExecution({ executionId: "turn_a1" })).rejects.toThrow("neo4j down");
    expect(mockNeoClose).toHaveBeenCalledTimes(1);
  });
});
