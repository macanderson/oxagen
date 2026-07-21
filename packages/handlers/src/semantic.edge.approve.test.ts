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
  getPinnedSchema: vi.fn(),
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

// Pinned-schema lookup hits Postgres via withTenantDb — mock it like
// graph.ingest.test.ts does. Default null = no pinned vocabulary (gates inert).
vi.mock("./schema.pinned", () => ({
  getPinnedSchema: (...a: unknown[]) => mocks.getPinnedSchema(...a),
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

function setupNeo4j(
  edgeRow: ReturnType<typeof makeRecord> | null,
  relId = "rel-id-1",
) {
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
  return {
    getCypher: (idx: number) => (mocks.runFn.mock.calls[idx] as [string])[0],
  };
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
    mocks.getPinnedSchema.mockResolvedValue(null);
  });

  it("throws 404 when InferredEdge is not found", async () => {
    setupNeo4j(null);

    await expect(
      semanticEdgeApproveHandler(
        { edgeId: "edge-missing", decision: "approve" },
        CTX,
      ),
    ).rejects.toMatchObject({ status: 404 });

    expect(mocks.closeFn).toHaveBeenCalledOnce();
  });

  it("throws 409 when edge is already approved (not pending)", async () => {
    // Override: return approved edge on the find call
    mocks.runFn.mockResolvedValueOnce({ records: [APPROVED_EDGE_ROW] });

    await expect(
      semanticEdgeApproveHandler(
        { edgeId: "edge-uuid-1", decision: "approve" },
        CTX,
      ),
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

    const [, params] = mocks.runFn.mock.calls[1] as [
      string,
      Record<string, unknown>,
    ];
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

    await semanticEdgeApproveHandler(
      { edgeId: "edge-uuid-2", decision: "approve" },
      CTX,
    );

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

    const [, params] = mocks.runFn.mock.calls[1] as [
      string,
      Record<string, unknown>,
    ];
    expect(params.approvedBy).toBe("user-1");
  });

  // OXA-2062: both the "find the edge" and "update approvalStatus" queries
  // reference $orgId (and the find query also $workspaceId) but the local
  // params objects previously omitted them, relying entirely on
  // scopedSession()'s auto-injection. This suite mocks scopedSession()
  // directly (no auto-injection), so this bug was invisible until
  // orgId/workspaceId were bound explicitly.
  it("binds orgId/workspaceId explicitly on the find query and orgId on the update query (regression: previously relied solely on scopedSession auto-injection)", async () => {
    setupNeo4j(PENDING_EDGE_ROW);

    await semanticEdgeApproveHandler(
      { edgeId: "edge-uuid-1", decision: "reject" },
      CTX,
    );

    const findParams = mocks.runFn.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(findParams.orgId).toBe(CTX.orgId);
    expect(findParams.workspaceId).toBe(CTX.workspaceId);

    const updateParams = mocks.runFn.mock.calls[1]?.[1] as Record<
      string,
      unknown
    >;
    expect(updateParams.orgId).toBe(CTX.orgId);
  });

  it("closes the session even when neo4j throws on the update step", async () => {
    // find OK, then SET throws
    mocks.runFn
      .mockResolvedValueOnce({ records: [PENDING_EDGE_ROW] })
      .mockRejectedValueOnce(new Error("write failed"));

    await expect(
      semanticEdgeApproveHandler(
        { edgeId: "edge-uuid-1", decision: "reject" },
        CTX,
      ),
    ).rejects.toThrow("write failed");

    expect(mocks.closeFn).toHaveBeenCalledOnce();
  });
});

// ── bi-temporal validity + supersession ───────────────────────────────────────

describe("semanticEdgeApproveHandler — bi-temporal validity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopedSession.mockReturnValue(sessionObj);
    mocks.runInTenantScope.mockImplementation(
      (_scope: unknown, fn: () => unknown) => Promise.resolve(fn()),
    );
    mocks.closeFn.mockResolvedValue(undefined);
    mocks.getPinnedSchema.mockResolvedValue(null);
  });

  function setupApprove(tgtId = "tgt-1", closed = 0) {
    let call = 0;
    mocks.runFn.mockImplementation(async () => {
      call++;
      if (call === 1) return { records: [PENDING_EDGE_ROW] };
      if (call === 2) return { records: [] };
      if (call === 3)
        return { records: [makeRecord({ relId: "rel-1", tgtId })] };
      return { records: [makeRecord({ closed })] }; // supersede close
    });
  }

  it("stamps validity on the materialised edge and threads observedAt", async () => {
    setupApprove();
    await semanticEdgeApproveHandler(
      {
        edgeId: "edge-uuid-1",
        decision: "approve",
        observedAt: "2019-03-03T00:00:00.000Z",
      },
      CTX,
    );
    const materializeCypher = (mocks.runFn.mock.calls[2] as [string])[0];
    expect(materializeCypher).toContain(
      "r.validFrom = coalesce(datetime($validFrom), datetime())",
    );
    expect(materializeCypher).toContain("r.recordedAt = datetime()");
    const materializeParams = (
      mocks.runFn.mock.calls[2] as [string, Record<string, unknown>]
    )[1];
    expect(materializeParams.validFrom).toBe("2019-03-03T00:00:00.000Z");
  });

  it("does not supersede by default (superseded=0, no close query)", async () => {
    setupApprove();
    const result = await semanticEdgeApproveHandler(
      { edgeId: "edge-uuid-1", decision: "approve" },
      CTX,
    );
    expect(result.superseded).toBe(0);
    // find + SET + materialise = 3 calls, no 4th close query.
    expect(mocks.runFn).toHaveBeenCalledTimes(3);
  });

  it("closes other open edges of the same type from the source when supersede=true", async () => {
    setupApprove("tgt-1", 3);
    const result = await semanticEdgeApproveHandler(
      { edgeId: "edge-uuid-1", decision: "approve", supersede: true },
      CTX,
    );
    expect(mocks.runFn).toHaveBeenCalledTimes(4);
    const closeCypher = (mocks.runFn.mock.calls[3] as [string])[0];
    expect(closeCypher).toContain("other.publicId <> $materializedTargetId");
    expect(closeCypher).toContain(
      "old.validTo IS NULL AND old.invalidatedAt IS NULL",
    );
    expect(closeCypher).not.toMatch(/DELETE/i);
    expect(result.superseded).toBe(3);
  });

  it("reject path reports superseded=0 and never materialises", async () => {
    let call = 0;
    mocks.runFn.mockImplementation(async () => {
      call++;
      if (call === 1) return { records: [PENDING_EDGE_ROW] };
      return { records: [] };
    });
    const result = await semanticEdgeApproveHandler(
      { edgeId: "edge-uuid-1", decision: "reject" },
      CTX,
    );
    expect(result.decision).toBe("reject");
    expect(result.superseded).toBe(0);
    expect(result.permanentEdgeId).toBeUndefined();
  });
});

// ── Agent RBAC Q3 gates (verify on approve) ───────────────────────────────────

describe("semantic.edge.approve — Q3 approval gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopedSession.mockReturnValue(sessionObj);
    mocks.runInTenantScope.mockImplementation(
      (_scope: unknown, fn: () => unknown) => Promise.resolve(fn()),
    );
    mocks.closeFn.mockResolvedValue(undefined);
    mocks.getPinnedSchema.mockResolvedValue(null);
  });

  /** CTX carrying an agentRun whose graph ceiling excludes the edge's target. */
  function agentCtx(labels: string[] | undefined) {
    const byCapability = new Map<string, unknown>();
    byCapability.set("semantic.edge.approve", {
      outcome: "allow",
      agentResolution: {},
      humanResolution: {},
      resourceScope: {
        graph: { mode: "extend", labels },
      },
    });
    return {
      ...CTX,
      agentRun: { resolution: { byCapability } },
    } as typeof CTX;
  }

  it("agent approve of an out-of-scope target label throws 422 BEFORE any write", async () => {
    mocks.runFn.mockResolvedValue({ records: [PENDING_EDGE_ROW] });

    await expect(
      semanticEdgeApproveHandler(
        { edgeId: "edge-uuid-1", decision: "approve" },
        agentCtx(["Service"]), // PENDING_EDGE_ROW.targetType is "Feature"
      ),
    ).rejects.toMatchObject({
      status: 422,
      dimension: "label",
      value: "Feature",
    });

    // Only the find query ran — the edge is still pending (retryable), never
    // stamped approved-but-unmaterialised.
    expect(mocks.runFn).toHaveBeenCalledTimes(1);
    expect(mocks.runFn.mock.calls[0]?.[0]).toMatch(/MATCH \(ie:InferredEdge/);
  });

  it("agent approve of an in-scope target proceeds to materialise", async () => {
    let call = 0;
    mocks.runFn.mockImplementation(async () => {
      call++;
      if (call === 1) return { records: [PENDING_EDGE_ROW] };
      if (call === 3)
        return { records: [makeRecord({ relId: "rel-1", tgtId: "tgt-1" })] };
      return { records: [] };
    });

    const result = await semanticEdgeApproveHandler(
      { edgeId: "edge-uuid-1", decision: "approve" },
      agentCtx(["Feature"]),
    );
    expect(result.decision).toBe("approve");
    expect(result.permanentEdgeId).toBe("rel-1");
  });

  it("agent REJECT of an out-of-scope proposal is permitted (narrowing)", async () => {
    let call = 0;
    mocks.runFn.mockImplementation(async () => {
      call++;
      if (call === 1) return { records: [PENDING_EDGE_ROW] };
      return { records: [] };
    });

    const result = await semanticEdgeApproveHandler(
      { edgeId: "edge-uuid-1", decision: "reject" },
      agentCtx(["Service"]),
    );
    expect(result.decision).toBe("reject");
  });

  it("strict workspace vocabulary blocks approval of an out-of-vocabulary type for ANY approver", async () => {
    mocks.runFn.mockResolvedValue({ records: [PENDING_EDGE_ROW] });
    mocks.getPinnedSchema.mockResolvedValue({
      registryId: "reg",
      versionId: "ver",
      versionNumber: 1,
      enforcementMode: "strict",
      conformanceFloor: 0,
      labels: [
        {
          schemaName: "s",
          name: "Service",
          displayName: "Service",
          description: null,
          naturalKeyProps: [],
          properties: [],
        },
      ],
      relationshipTypes: [],
    });

    // Plain human CTX — no agentRun; the vocabulary gate binds regardless.
    await expect(
      semanticEdgeApproveHandler(
        { edgeId: "edge-uuid-1", decision: "approve" },
        CTX,
      ),
    ).rejects.toMatchObject({ status: 422, dimension: "label" });
    expect(mocks.runFn).toHaveBeenCalledTimes(1);
  });

  it("non-strict workspace + human approver: gates are inert (unchanged behavior)", async () => {
    let call = 0;
    mocks.runFn.mockImplementation(async () => {
      call++;
      if (call === 1) return { records: [PENDING_EDGE_ROW] };
      if (call === 3)
        return { records: [makeRecord({ relId: "rel-1", tgtId: "tgt-1" })] };
      return { records: [] };
    });

    const result = await semanticEdgeApproveHandler(
      { edgeId: "edge-uuid-1", decision: "approve" },
      CTX,
    );
    expect(result.decision).toBe("approve");
    expect(result.permanentEdgeId).toBe("rel-1");
  });
});
