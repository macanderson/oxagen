/**
 * Unit tests for semantic.edge.list handler.
 *
 * Verifies:
 * - Queries Neo4j with correct Cypher including all filter params
 * - Returns edges with correct shape (approved flag, approvedAt, approvedBy)
 * - Passes null for absent filters (type, sourceId, confidenceMin, confidenceMax)
 * - Applies pagination (offset, limit) to the Cypher query
 * - Returns correct total from the count query
 * - Returns empty array when no edges match
 * - Closes the session on success and on error
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

const sessionObj = { run: mocks.runFn, close: mocks.closeFn };
mocks.scopedSession.mockReturnValue(sessionObj);
mocks.runInTenantScope.mockImplementation(
  (_scope: unknown, fn: () => unknown) => Promise.resolve(fn()),
);

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: mocks.scopedSession,
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));

import { semanticEdgeListHandler } from "./semantic.edge.list";

// ── helpers ───────────────────────────────────────────────────────────────────

const CTX = makeCTX({ orgId: "org-1", workspaceId: "ws-1" });

function makeRecord(fields: Record<string, unknown>) {
  return { get: (k: string) => fields[k] };
}

function makeEdgeRow(overrides: Record<string, unknown> = {}) {
  return makeRecord({
    id: "edge-uuid-1",
    sourceNodeId: "node-a",
    sourceDisplayName: "Billing Subscription Streaming",
    sourceLabel: "Feature",
    sourceProperties: JSON.stringify({ path: "src/billing.ts" }),
    targetName: "OAuth Login",
    targetType: "Feature",
    type: "IMPLEMENTS",
    confidence: 0.85,
    connectorId: "github",
    sourceId: "github",
    llmModel: "ingestion-semantic-edge-infer",
    approvalStatus: "approved",
    approvedAt: "2025-01-01T12:00:00.000Z",
    approvedBy: "user-1",
    inferredAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function setupNeo4j(edgeRecords: ReturnType<typeof makeRecord>[], total = edgeRecords.length) {
  let callCount = 0;
  mocks.runFn.mockImplementation(async () => {
    callCount++;
    if (callCount === 1) return { records: edgeRecords };
    return { records: [makeRecord({ total })] };
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("semanticEdgeListHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopedSession.mockReturnValue(sessionObj);
    mocks.runInTenantScope.mockImplementation(
      (_scope: unknown, fn: () => unknown) => Promise.resolve(fn()),
    );
    mocks.closeFn.mockResolvedValue(undefined);
  });

  it("returns empty edges when no edges exist", async () => {
    setupNeo4j([], 0);

    const result = await semanticEdgeListHandler(
      { limit: 50, offset: 0 },
      CTX,
    );

    expect(result.edges).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(0);
  });

  it("returns edges with correct shape including approved metadata", async () => {
    setupNeo4j([makeEdgeRow()]);

    const result = await semanticEdgeListHandler(
      { limit: 50, offset: 0 },
      CTX,
    );

    expect(result.edges).toHaveLength(1);
    const e = result.edges[0]!;
    expect(e.id).toBe("edge-uuid-1");
    expect(e.sourceNodeId).toBe("node-a");
    expect(e.type).toBe("IMPLEMENTS");
    expect(e.confidence).toBe(0.85);
    expect(e.approved).toBe(true);
    expect(e.approvedAt).toBe("2025-01-01T12:00:00.000Z");
    expect(e.approvedBy).toBe("user-1");
  });

  it("cites the source node by its resolved label + properties, never a bare UUID", async () => {
    setupNeo4j([makeEdgeRow()]);

    const result = await semanticEdgeListHandler({ limit: 50, offset: 0 }, CTX);
    const e = result.edges[0]!;

    expect(e.sourceNode).toBeDefined();
    expect(e.sourceNode!.id).toBe("node-a");
    expect(e.sourceNode!.label).toBe("Feature");
    expect(e.sourceNode!.displayName).toBe("Billing Subscription Streaming");
    expect(e.sourceNode!.properties).toEqual({ path: "src/billing.ts" });
    expect(e.targetNode!.displayName).toBe("OAuth Login");
    expect(e.relationshipProperties).toMatchObject({
      relationshipType: "IMPLEMENTS",
      approvalStatus: "approved",
      model: "ingestion-semantic-edge-infer",
    });

    const [cypher] = mocks.runFn.mock.calls[0] as [string, Record<string, unknown>];
    expect(cypher).toContain("OPTIONAL MATCH (src:GraphNode {publicId: ie.sourceNodeId");
  });

  it("marks edge as approved=false when approvalStatus is pending", async () => {
    setupNeo4j([makeEdgeRow({ approvalStatus: "pending", approvedAt: null, approvedBy: null })]);

    const result = await semanticEdgeListHandler({ limit: 50, offset: 0 }, CTX);

    expect(result.edges[0]!.approved).toBe(false);
    expect(result.edges[0]!.approvedAt).toBeNull();
    expect(result.edges[0]!.approvedBy).toBeNull();
  });

  it("passes type and sourceId filters to Cypher", async () => {
    setupNeo4j([]);

    await semanticEdgeListHandler(
      { type: "IMPLEMENTS", sourceId: "conn-123", limit: 25, offset: 0 },
      CTX,
    );

    const [, params] = mocks.runFn.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.type).toBe("IMPLEMENTS");
    expect(params.sourceId).toBe("conn-123");
  });

  it("passes null for absent optional filters", async () => {
    setupNeo4j([]);

    await semanticEdgeListHandler({ limit: 50, offset: 0 }, CTX);

    const [, params] = mocks.runFn.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.type).toBeNull();
    expect(params.sourceId).toBeNull();
    expect(params.confidenceMin).toBeNull();
    expect(params.confidenceMax).toBeNull();
  });

  it("passes BigInt offset and limit to Cypher", async () => {
    setupNeo4j([]);

    await semanticEdgeListHandler({ limit: 25, offset: 50 }, CTX);

    const [, params] = mocks.runFn.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.offset).toBe(BigInt(50));
    expect(params.limit).toBe(BigInt(25));
  });

  it("returns the correct total from the count query", async () => {
    setupNeo4j([makeEdgeRow()], 99);

    const result = await semanticEdgeListHandler({ limit: 50, offset: 0 }, CTX);
    expect(result.total).toBe(99);
  });

  it("closes the session on success", async () => {
    setupNeo4j([]);
    await semanticEdgeListHandler({ limit: 50, offset: 0 }, CTX);
    expect(mocks.closeFn).toHaveBeenCalledOnce();
  });

  it("closes the session even when neo4j throws", async () => {
    mocks.runFn.mockRejectedValueOnce(new Error("Neo4j gone"));

    await expect(
      semanticEdgeListHandler({ limit: 50, offset: 0 }, CTX),
    ).rejects.toThrow("Neo4j gone");

    expect(mocks.closeFn).toHaveBeenCalledOnce();
  });

  it("filters confidence range when provided", async () => {
    setupNeo4j([]);

    await semanticEdgeListHandler(
      { confidenceMin: 0.7, confidenceMax: 0.99, limit: 50, offset: 0 },
      CTX,
    );

    const [, params] = mocks.runFn.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.confidenceMin).toBe(0.7);
    expect(params.confidenceMax).toBe(0.99);
  });
});
