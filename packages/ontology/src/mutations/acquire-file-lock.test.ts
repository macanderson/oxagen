import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted — factory must not reference variables declared after it.
vi.mock("../tenant", () => ({
  scopedSession: vi.fn().mockReturnValue({
    run: vi.fn().mockResolvedValue({ records: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

import { scopedSession } from "../tenant";
import { acquireFileLock, DEFAULT_FILE_LOCK_TTL_MS } from "./acquire-file-lock";

const mockScopedSession = vi.mocked(scopedSession);

function mockRecord(fields: Record<string, unknown>) {
  return { get: (key: string) => fields[key] };
}

describe("acquireFileLock", () => {
  let mockNeoRun: ReturnType<typeof vi.fn>;
  let mockNeoClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockNeoRun = vi.fn().mockResolvedValue({ records: [mockRecord({ granted: true, heldBy: null, blockedUntil: null })] });
    mockNeoClose = vi.fn().mockResolvedValue(undefined);
    mockScopedSession.mockReturnValue({ run: mockNeoRun, close: mockNeoClose });
  });

  const BASE_INPUT = {
    naturalKey: "github:oxageninc/oxagen-platform:src/foo.ts",
    agentId: "agent-a",
    executionId: "turn_a1",
    workspaceId: "ws-1",
  };

  it("MERGEs the SourceFile keyed by naturalKey + orgId", async () => {
    await acquireFileLock(BASE_INPUT);
    const cypher = mockNeoRun.mock.calls[0]![0] as string;
    expect(cypher).toContain("MERGE (f:SourceFile {naturalKey: $naturalKey, orgId: $orgId})");
  });

  it("checks for a live conflicting lock held by a DIFFERENT agent", async () => {
    await acquireFileLock(BASE_INPUT);
    const cypher = mockNeoRun.mock.calls[0]![0] as string;
    expect(cypher).toContain("OPTIONAL MATCH");
    expect(cypher).toContain("HOLDS_LOCK");
    expect(cypher).toContain("l.expiresAt > $now");
    expect(cypher).toContain("other.id <> $agentId");
  });

  it("only MERGEs the Agent + HOLDS_LOCK edge when no conflicting lock exists (CALL subquery guard)", async () => {
    await acquireFileLock(BASE_INPUT);
    const cypher = mockNeoRun.mock.calls[0]![0] as string;
    expect(cypher).toContain("CALL {");
    expect(cypher).toContain("WHERE l IS NULL");
    expect(cypher).toContain("MERGE (a:Agent {id: $agentId, orgId: $orgId})");
    expect(cypher).toContain("MERGE (a)-[h:HOLDS_LOCK]->(f)");
  });

  it("sets lockId, acquiredAt, expiresAt, workspaceId, action, executionId on the edge", async () => {
    await acquireFileLock(BASE_INPUT);
    const cypher = mockNeoRun.mock.calls[0]![0] as string;
    expect(cypher).toContain("h.lockId = $lockId");
    expect(cypher).toContain("h.acquiredAt = $now");
    expect(cypher).toContain("h.expiresAt = $now + $ttlMs");
    expect(cypher).toContain("h.workspaceId = $workspaceId");
    expect(cypher).toContain("h.action = $action");
    expect(cypher).toContain("h.executionId = $executionId");
  });

  it("defaults ttlMs to DEFAULT_FILE_LOCK_TTL_MS (300_000, mirrors IntentLedger)", async () => {
    await acquireFileLock(BASE_INPUT);
    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    expect(params.ttlMs).toBe(DEFAULT_FILE_LOCK_TTL_MS);
    expect(DEFAULT_FILE_LOCK_TTL_MS).toBe(300_000);
  });

  it("defaults action to 'write'", async () => {
    await acquireFileLock(BASE_INPUT);
    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    expect(params.action).toBe("write");
  });

  it("generates a lockId when the caller doesn't supply one", async () => {
    const result = await acquireFileLock(BASE_INPUT);
    expect(typeof result.lockId).toBe("string");
    expect(result.lockId.length).toBeGreaterThan(0);
  });

  it("honours a caller-supplied lockId, ttlMs, action, and now", async () => {
    await acquireFileLock({ ...BASE_INPUT, lockId: "lock-1", ttlMs: 60_000, action: "read", now: 1_000 });
    const params = mockNeoRun.mock.calls[0]![1] as Record<string, unknown>;
    expect(params.lockId).toBe("lock-1");
    expect(params.ttlMs).toBe(60_000);
    expect(params.action).toBe("read");
    expect(params.now).toBe(1_000);
  });

  it("returns granted:true and no heldBy/blockedUntil on success", async () => {
    mockNeoRun.mockResolvedValue({
      records: [mockRecord({ granted: true, heldBy: null, blockedUntil: null })],
    });
    const result = await acquireFileLock(BASE_INPUT);
    expect(result.granted).toBe(true);
    expect(result.heldBy).toBeNull();
    expect(result.blockedUntil).toBeNull();
  });

  it("returns granted:false with heldBy + blockedUntil when a different agent holds a live lock", async () => {
    mockNeoRun.mockResolvedValue({
      records: [mockRecord({ granted: false, heldBy: "agent-b", blockedUntil: 5_000 })],
    });
    const result = await acquireFileLock(BASE_INPUT);
    expect(result.granted).toBe(false);
    expect(result.heldBy).toBe("agent-b");
    expect(result.blockedUntil).toBe(5_000);
  });

  it("treats an empty result set as not granted rather than throwing", async () => {
    mockNeoRun.mockResolvedValue({ records: [] });
    const result = await acquireFileLock(BASE_INPUT);
    expect(result.granted).toBe(false);
  });

  it("always closes the session, even on failure", async () => {
    mockNeoRun.mockRejectedValue(new Error("neo4j down"));
    await expect(acquireFileLock(BASE_INPUT)).rejects.toThrow("neo4j down");
    expect(mockNeoClose).toHaveBeenCalledTimes(1);
  });
});
