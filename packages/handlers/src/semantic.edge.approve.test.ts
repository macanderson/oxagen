/**
 * Unit tests for semantic.edge.approve handler.
 *
 * Verifies:
 * - Throws 404 when InferredEdge not found in Neo4j
 * - Throws 409 when edge is already approved/rejected (not pending)
 * - Reject: updates approvalStatus to "rejected", returns decision + no permanentEdgeId
 * - Approve: updates approvalStatus to "approved", creates a permanent relationship
 *   typed by the inferred kind (e.g. :IMPLEMENTS) with inferred-origin properties,
 *   returns decision + permanentEdgeId
 * - Attaches optional comment to the InferredEdge on reject
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

import { semanticEdgeApproveHandler } from "./semantic.edge.approve";

// ── helpers ───────────────────────────────────────────────────────────────────

const CTX = makeCTX({ orgId: "org-1", workspaceId: "ws-1", userId: "user-1" });

function makeRecord(fields: Record<string, unknown>) {
  return { get: (k: string) => fields[k] };
}

const PENDING_EDGE_ROW = makeRecord({
  id: "edge-uuid-1",
  sourceNodeId: "node-a",
  targetType: "Feature",
  targetName: "OAuth Login",
  relationshipType: "IMPLEMENTS",
  confidence: 0.88,
  approvalStatus: "pending",
});

const APPROVED_EDGE_ROW = makeRecord({
  id: "edge-uuid-1",
  sourceNodeId: "node-a",
  targetType: "Feature",
  targetName: "OAuth Login",
  relationshipType: "IMPLEMENTS",
  confidence: 0.88,
  approvalStatus: "approved",
});

function setupNeo4j(edgeRow: ReturnType<typeof makeRecord> | null, relId = "rel-id-1") {
  let callCount = 0;
  mocks.runFn.mockImplementation(async () => {
    callCount++;
    // First call: find the edge
    if (callCount === 1) {
      return { records: edgeRow ? [edgeRow] : [] };
    }
    // Second call: update the InferredEdge (SET)
    if (callCount === 2) {
      return { records: [] };
    }
    // Third call: approve path only — materialise the descriptive relationship
    return { records: [makeRecord({ relId })] };
  });
  return { getCypher: (idx: number) => (mocks.runFn.mock.calls[idx] as [string])[0] };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("semanticEdgeApproveHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopedSession.mockReturnValue(sessionObj);
    mocks.runInTenantScope.mockImplementation(
      (_scope: unknown, fn: () => unknown) => Promise.resolve(fn()),
    );
    mocks.closeFn.mockResolvedValue(undefined);
  });

  it("throws 404 when InferredEdge is not found", async () => {
    setupNeo4j(null);

    await expect(
      semanticEdgeApproveHandler({ edgeId: "edge-missing", decision: "approve" }, CTX),
    ).rejects.toMatchObject({ status: 404 });

    expect(mocks.closeFn).toHaveBeenCalledOnce();
  });

  it("throws 409 when edge is already approved (not pending)", async () => {
    // Override: return approved edge on the find call
    mocks.runFn.mockResolvedValueOnce({ records: [APPROVED_EDGE_ROW] });

    await expect(
      semanticEdgeApproveHandler({ edgeId: "edge-uuid-1", decision: "approve" }, CTX),
    ).rejects.toMatchObject({ status: 409 });

    expect(mocks.closeFn).toHaveBeenCalledOnce();
  });

  it("reject: updates approvalStatus to rejected and returns correct output", async () => {
    const { getCypher } = setupNeo4j(PENDING_EDGE_ROW);

    const result = await semanticEdgeApproveHandler(
      { edgeId: "edge-uuid-1", decision: "reject" },
      CTX,
    );

    expect(result.edgeId).toBe("edge-uuid-1");
    expect(result.decision).toBe("reject");
    expect(result.permanentEdgeId).toBeUndefined();

    // Second call should SET approvalStatus = 'rejected'
    const updateCypher = getCypher(1);
    expect(updateCypher).toContain("approvalStatus");
    expect(mocks.closeFn).toHaveBeenCalledOnce();
  });

  it("reject: attaches comment to InferredEdge update", async () => {
    setupNeo4j(PENDING_EDGE_ROW);

    await semanticEdgeApproveHandler(
      { edgeId: "edge-uuid-1", decision: "reject", comment: "low quality" },
      CTX,
    );

    const [, params] = mocks.runFn.mock.calls[1] as [string, Record<string, unknown>];
    expect(params.comment).toBe("low quality");
  });

  it("approve: updates approvalStatus to approved and creates permanent relationship", async () => {
    const { getCypher } = setupNeo4j(PENDING_EDGE_ROW, "neo4j-rel-123");

    const result = await semanticEdgeApproveHandler(
      { edgeId: "edge-uuid-1", decision: "approve" },
      CTX,
    );

    expect(result.edgeId).toBe("edge-uuid-1");
    expect(result.decision).toBe("approve");
    expect(result.permanentEdgeId).toBe("neo4j-rel-123");

    // Third call should MERGE a relationship typed by the inferred kind itself
    // (PENDING_EDGE_ROW.relationshipType === "IMPLEMENTS") — never a generic
    // :SEMANTIC_EDGE — and mark the inferred provenance as a property.
    const relCypher = getCypher(2);
    expect(relCypher).toContain("[r:IMPLEMENTS");
    expect(relCypher).not.toContain("SEMANTIC_EDGE");
    expect(relCypher).toContain("r.inferred    = true");
    expect(relCypher).toContain("r.origin      = 'semantic'");
    // The materialised target carries its descriptive PascalCase domain label
    // (PENDING_EDGE_ROW.targetType === "Feature"), never an anchor-only node.
    expect(relCypher).toContain("SET tgt:Feature");
    expect(mocks.closeFn).toHaveBeenCalledOnce();
  });

  it("approve: sanitizes a non-identifier relationship type before interpolation", async () => {
    // A model could emit a type with spaces/hyphens; it must never reach the
    // query as-is (Cypher injection surface) — it is coerced to UPPER_SNAKE_CASE.
    const messyRow = makeRecord({
      id: "edge-uuid-2",
      sourceNodeId: "node-a",
      targetType: "Service",
      targetName: "Billing",
      relationshipType: "depends on (heavily)",
      confidence: 0.9,
      approvalStatus: "pending",
    });
    const { getCypher } = setupNeo4j(messyRow, "rel-2");

    await semanticEdgeApproveHandler({ edgeId: "edge-uuid-2", decision: "approve" }, CTX);

    const relCypher = getCypher(2);
    expect(relCypher).toContain("[r:DEPENDS_ON_HEAVILY");
    expect(relCypher).not.toContain("depends on");
  });

  it("approve: sets approvedBy from CTX userId", async () => {
    setupNeo4j(PENDING_EDGE_ROW);

    await semanticEdgeApproveHandler(
      { edgeId: "edge-uuid-1", decision: "approve" },
      CTX,
    );

    const [, params] = mocks.runFn.mock.calls[1] as [string, Record<string, unknown>];
    expect(params.approvedBy).toBe("user-1");
  });

  it("closes the session even when neo4j throws on the update step", async () => {
    // find OK, then SET throws
    mocks.runFn
      .mockResolvedValueOnce({ records: [PENDING_EDGE_ROW] })
      .mockRejectedValueOnce(new Error("write failed"));

    await expect(
      semanticEdgeApproveHandler({ edgeId: "edge-uuid-1", decision: "reject" }, CTX),
    ).rejects.toThrow("write failed");

    expect(mocks.closeFn).toHaveBeenCalledOnce();
  });
});
