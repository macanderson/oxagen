import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../tenant", () => ({
  scopedSession: vi.fn().mockReturnValue({
    run: vi.fn().mockResolvedValue({ records: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { scopedSession } from "../tenant";
import { listFileLocks } from "./list-file-locks";

const mockScopedSession = vi.mocked(scopedSession);

function mockRecord(fields: Record<string, unknown>) {
  return { get: (key: string) => fields[key] };
}

describe("listFileLocks", () => {
  let mockNeoRun: ReturnType<typeof vi.fn>;
  let mockNeoClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockNeoRun = vi.fn().mockResolvedValue({ records: [] });
    mockNeoClose = vi.fn().mockResolvedValue(undefined);
    mockScopedSession.mockReturnValue({ run: mockNeoRun, close: mockNeoClose });
  });

  it("matches only LIVE HOLDS_LOCK edges (expiresAt > now)", async () => {
    await listFileLocks();
    const cypher = mockNeoRun.mock.calls[0]![0] as string;
    expect(cypher).toContain("HOLDS_LOCK");
    expect(cypher).toContain("l.expiresAt > $now");
  });

  it("passes naturalKey:null when no filter is given (lists every live lock in the org)", async () => {
    await listFileLocks();
    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    expect(params.naturalKey).toBeNull();
  });

  it("filters by naturalKey when provided", async () => {
    await listFileLocks({ naturalKey: "github:owner/repo:src/a.ts" });
    const cypher = mockNeoRun.mock.calls[0]![0] as string;
    expect(cypher).toContain("f.naturalKey = $naturalKey");
    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    expect(params.naturalKey).toBe("github:owner/repo:src/a.ts");
  });

  it("maps every column into a FileLockRecord", async () => {
    mockNeoRun.mockResolvedValue({
      records: [
        mockRecord({
          lockId: "lock-1",
          naturalKey: "github:owner/repo:src/a.ts",
          agentId: "agent-a",
          acquiredAt: 1000,
          expiresAt: 301000,
          workspaceId: "ws-1",
          action: "write",
          executionId: "turn-1",
        }),
      ],
    });
    const result = await listFileLocks();
    expect(result.locks).toEqual([
      {
        lockId: "lock-1",
        naturalKey: "github:owner/repo:src/a.ts",
        agentId: "agent-a",
        acquiredAt: 1000,
        expiresAt: 301000,
        workspaceId: "ws-1",
        action: "write",
        executionId: "turn-1",
      },
    ]);
  });

  it("returns an empty array when nothing is live", async () => {
    const result = await listFileLocks();
    expect(result.locks).toEqual([]);
  });

  it("always closes the session, even on failure", async () => {
    mockNeoRun.mockRejectedValue(new Error("neo4j down"));
    await expect(listFileLocks()).rejects.toThrow("neo4j down");
    expect(mockNeoClose).toHaveBeenCalledTimes(1);
  });
});
