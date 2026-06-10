/**
 * Unit tests for semantic.edge.suggest handler.
 *
 * Verifies:
 * - Calls Neo4j via scopedSession with correct Cypher
 * - Applies confidence filters correctly (null = no filter)
 * - Returns suggestions sorted by confidence DESC with correct shape
 * - Returns empty array when no pending edges exist
 * - Propagates Neo4j errors as thrown exceptions
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeCTX } from "./test-utils/fixtures";

// ── mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  runFn: vi.fn(),
  closeFn: vi.fn().mockResolvedValue(undefined),
  scopedSession: vi.fn(),
  runInTenantScope: vi.fn(),
}));

// scopedSession returns an object whose run() is mocked
const sessionObj = { run: mocks.runFn, close: mocks.closeFn };
mocks.scopedSession.mockReturnValue(sessionObj);

// runInTenantScope invokes the callback immediately
mocks.runInTenantScope.mockImplementation(
  (_scope: unknown, fn: () => unknown) => Promise.resolve(fn()),
);

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: mocks.scopedSession,
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));

import { semanticEdgeSuggestHandler } from "./semantic.edge.suggest";

// ── helpers ───────────────────────────────────────────────────────────────────

const CTX = makeCTX({ orgId: "org-1", workspaceId: "ws-1" });

/** Build a fake neo4j Record with `.get(key)` */
function makeRecord(fields: Record<string, unknown>) {
  return { get: (k: string) => fields[k] };
}

function makeEdgeRow(overrides: Record<string, unknown> = {}) {
  return makeRecord({
    id: "edge-uuid-1",
    sourceNodeId: "node-a",
    targetType: "Feature",
    targetName: "OAuth Login",
    type: "IMPLEMENTS",
    confidence: 0.9,
    connectorId: "github",
    sourceId: "github",
    inferredAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function setupNeo4j(edgeRecords: ReturnType<typeof makeRecord>[], total = edgeRecords.length) {
  let callCount = 0;
  mocks.runFn.mockImplementation(async () => {
    callCount++;
    // First call: MATCH query returning edges
    if (callCount === 1) return { records: edgeRecords };
    // Second call: count query
    return { records: [makeRecord({ total })] };
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("semanticEdgeSuggestHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopedSession.mockReturnValue(sessionObj);
    mocks.runInTenantScope.mockImplementation(
      (_scope: unknown, fn: () => unknown) => Promise.resolve(fn()),
    );
    mocks.closeFn.mockResolvedValue(undefined);
  });

  it("returns empty suggestions when no pending edges exist", async () => {
    setupNeo4j([], 0);

    const result = await semanticEdgeSuggestHandler(
      { limit: 50 },
      CTX,
    );

    expect(result.suggestions).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.limit).toBe(50);
  });

  it("returns suggestions with correct shape", async () => {
    setupNeo4j([makeEdgeRow()]);

    const result = await semanticEdgeSuggestHandler(
      { limit: 50 },
      CTX,
    );

    expect(result.suggestions).toHaveLength(1);
    const s = result.suggestions[0]!;
    expect(s.id).toBe("edge-uuid-1");
    expect(s.sourceNodeId).toBe("node-a");
    expect(s.type).toBe("IMPLEMENTS");
    expect(s.confidence).toBe(0.9);
    expect(s.approved).toBe(false);
    expect(s.approvedAt).toBeNull();
    expect(s.approvedBy).toBeNull();
  });

  it("passes confidenceMin and confidenceMax to the Cypher query", async () => {
    setupNeo4j([]);

    await semanticEdgeSuggestHandler(
      { confidenceMin: 0.5, confidenceMax: 0.95, limit: 10 },
      CTX,
    );

    const [cypher, params] = mocks.runFn.mock.calls[0] as [string, Record<string, unknown>];
    expect(cypher).toContain("approvalStatus: 'pending'");
    expect(params.confidenceMin).toBe(0.5);
    expect(params.confidenceMax).toBe(0.95);
    expect(params.limit).toBe(BigInt(10));
  });

  it("passes null for absent confidence filters", async () => {
    setupNeo4j([]);

    await semanticEdgeSuggestHandler({ limit: 50 }, CTX);

    const [, params] = mocks.runFn.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.confidenceMin).toBeNull();
    expect(params.confidenceMax).toBeNull();
  });

  it("closes the session on success", async () => {
    setupNeo4j([]);
    await semanticEdgeSuggestHandler({ limit: 50 }, CTX);
    expect(mocks.closeFn).toHaveBeenCalledOnce();
  });

  it("closes the session even when neo4j throws", async () => {
    mocks.runFn.mockRejectedValueOnce(new Error("Neo4j unavailable"));

    await expect(
      semanticEdgeSuggestHandler({ limit: 50 }, CTX),
    ).rejects.toThrow("Neo4j unavailable");

    expect(mocks.closeFn).toHaveBeenCalledOnce();
  });

  it("returns correct total from the count query", async () => {
    setupNeo4j([makeEdgeRow()], 42);

    const result = await semanticEdgeSuggestHandler({ limit: 50 }, CTX);
    expect(result.total).toBe(42);
  });
});
