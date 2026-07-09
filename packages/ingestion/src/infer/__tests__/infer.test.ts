import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  sessionRun: vi.fn(),
  sessionClose: vi.fn().mockResolvedValue(undefined),
  scopedSession: vi.fn(),
  generateObjectFor: vi.fn(),
  upsertInferredEdges: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: mocks.scopedSession,
}));

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectFor,
}));

vi.mock("../../mutations/upsert-entity", () => ({
  upsertInferredEdges: mocks.upsertInferredEdges,
}));

import { inferSemanticEdges } from "../index";
import type { SemanticInferenceJob } from "../../types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<SemanticInferenceJob> = {}): SemanticInferenceJob {
  return {
    nodeId: "node-uuid-1",
    entityType: "task",
    propertiesSnapshot: { title: "Add OAuth", state: "open" },
    workspaceId: "ws-1",
    orgId: "org-1",
    ...overrides,
  };
}

function makeSession(runResult: { records: unknown[] }) {
  return {
    run: vi.fn().mockResolvedValue(runResult),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("inferSemanticEdges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.upsertInferredEdges.mockResolvedValue(undefined);
  });

  it("returns empty output when node is not found in Neo4j", async () => {
    mocks.scopedSession.mockReturnValue(makeSession({ records: [] }));

    const result = await inferSemanticEdges(makeJob());

    expect(result.nodeId).toBe("node-uuid-1");
    expect(result.inferredEdges).toEqual([]);
    expect(result.inferredNodes).toEqual([]);
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
    expect(mocks.upsertInferredEdges).not.toHaveBeenCalled();
  });

  it("calls generateObjectFor with correct schema and telemetry when node is found", async () => {
    const nodeSession = makeSession({
      records: [
        { get: (k: string) => ({ naturalKey: "github:conn-1:42", displayName: "Add OAuth" })[k] },
      ],
    });
    // generateObjectFor returns edges pointing to naturalKeys
    mocks.generateObjectFor.mockResolvedValue({
      object: {
        inferredEdges: [
          { targetNaturalKey: "github:conn-1:99", edgeType: "REFERENCES", confidence: 0.85, rationale: "Related PR" },
        ],
      },
    });
    // Resolve session: targetNaturalKey → no matching node
    const resolveSession = makeSession({ records: [] });

    let callCount = 0;
    mocks.scopedSession.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return nodeSession;
      return resolveSession;
    });

    const result = await inferSemanticEdges(makeJob());

    expect(mocks.generateObjectFor).toHaveBeenCalledOnce();
    const callArgs = mocks.generateObjectFor.mock.calls[0]![0] as {
      telemetry: { orgId: string; workspaceId: string; surface: string; messageId: string | null };
    };
    expect(callArgs.telemetry.orgId).toBe("org-1");
    expect(callArgs.telemetry.workspaceId).toBe("ws-1");
    expect(callArgs.telemetry.surface).toBe("ingestion");
    // No initiating message for ingestion-time inference → null, never a
    // synthesized `infer:<nodeId>` string. That non-UUID value flooded the
    // token_usage UUID column (CANNOT_PARSE_INPUT_ASSERTION_FAILED).
    expect(callArgs.telemetry.messageId).toBeNull();

    // target node not in graph → no edges written, return empty
    expect(result.inferredEdges).toHaveLength(0);
    expect(mocks.upsertInferredEdges).not.toHaveBeenCalled();
  });

  it("writes edges for targets that exist in the graph", async () => {
    const nodeSession = makeSession({
      records: [
        { get: (k: string) => ({ naturalKey: "github:conn-1:42", displayName: "Task A" })[k] },
      ],
    });
    mocks.generateObjectFor.mockResolvedValue({
      object: {
        inferredEdges: [
          { targetNaturalKey: "github:conn-1:55", edgeType: "PART_OF", confidence: 0.9, rationale: "Part of feature" },
        ],
      },
    });
    // Resolve session: returns matching node for the target naturalKey
    const resolveSession = makeSession({
      records: [
        { get: (k: string) => ({ naturalKey: "github:conn-1:55", nodeId: "target-node-id" })[k] },
      ],
    });

    let callCount = 0;
    mocks.scopedSession.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return nodeSession;
      return resolveSession;
    });

    const result = await inferSemanticEdges(makeJob());

    expect(mocks.upsertInferredEdges).toHaveBeenCalledOnce();
    const edgesArg = mocks.upsertInferredEdges.mock.calls[0]![0] as Array<{
      fromNodeId: string;
      toNodeId: string;
      edgeType: string;
      confidence: number;
    }>;
    expect(edgesArg).toHaveLength(1);
    expect(edgesArg[0]!.fromNodeId).toBe("node-uuid-1");
    expect(edgesArg[0]!.toNodeId).toBe("target-node-id");
    expect(edgesArg[0]!.edgeType).toBe("PART_OF");
    expect(edgesArg[0]!.confidence).toBe(0.9);

    expect(result.inferredEdges).toHaveLength(1);
    expect(result.inferredEdges[0]!.targetNodeId).toBe("target-node-id");
    expect(result.inferredEdges[0]!.edgeType).toBe("PART_OF");
  });

  it("drops inferred edges below the confidence threshold (default 0.75)", async () => {
    const nodeSession = makeSession({
      records: [
        { get: (k: string) => ({ naturalKey: "github:conn-1:42", displayName: "Task A" })[k] },
      ],
    });
    // One sub-threshold edge (0.5) and one above-threshold edge (0.9).
    mocks.generateObjectFor.mockResolvedValue({
      object: {
        inferredEdges: [
          { targetNaturalKey: "github:conn-1:low", edgeType: "REFERENCES", confidence: 0.5, rationale: "weak" },
          { targetNaturalKey: "github:conn-1:high", edgeType: "PART_OF", confidence: 0.9, rationale: "strong" },
        ],
      },
    });
    // Resolve session: both naturalKeys map to graph nodes, so only the
    // threshold filter (not graph resolution) can drop the weak edge.
    const resolveSession = makeSession({
      records: [
        { get: (k: string) => ({ naturalKey: "github:conn-1:low", nodeId: "low-node" })[k] },
        { get: (k: string) => ({ naturalKey: "github:conn-1:high", nodeId: "high-node" })[k] },
      ],
    });

    let callCount = 0;
    mocks.scopedSession.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return nodeSession;
      return resolveSession;
    });

    const result = await inferSemanticEdges(makeJob());

    // Only the resolve query should receive the above-threshold naturalKey.
    const resolveParams = resolveSession.run.mock.calls[0]![1] as { naturalKeys: string[] };
    expect(resolveParams.naturalKeys).toEqual(["github:conn-1:high"]);

    expect(mocks.upsertInferredEdges).toHaveBeenCalledOnce();
    const edgesArg = mocks.upsertInferredEdges.mock.calls[0]![0] as Array<{ toNodeId: string }>;
    expect(edgesArg).toHaveLength(1);
    expect(edgesArg[0]!.toNodeId).toBe("high-node");

    expect(result.inferredEdges).toHaveLength(1);
    expect(result.inferredEdges[0]!.targetNodeId).toBe("high-node");
  });

  it("returns empty edges when all inferred edges are below the confidence threshold", async () => {
    const nodeSession = makeSession({
      records: [
        { get: (k: string) => ({ naturalKey: "github:conn-1:42", displayName: "Task A" })[k] },
      ],
    });
    mocks.generateObjectFor.mockResolvedValue({
      object: {
        inferredEdges: [
          { targetNaturalKey: "github:conn-1:weak", edgeType: "REFERENCES", confidence: 0.1, rationale: "noise" },
        ],
      },
    });
    mocks.scopedSession.mockReturnValue(nodeSession);

    const result = await inferSemanticEdges(makeJob());

    expect(result.inferredEdges).toHaveLength(0);
    // No resolve query and no write should happen once the only edge is filtered.
    expect(nodeSession.run).toHaveBeenCalledTimes(1);
    expect(mocks.upsertInferredEdges).not.toHaveBeenCalled();
  });

  it("returns empty edges when generateObjectFor returns no inferredEdges", async () => {
    const nodeSession = makeSession({
      records: [
        { get: (k: string) => ({ naturalKey: "github:conn-1:42", displayName: "Task A" })[k] },
      ],
    });
    mocks.generateObjectFor.mockResolvedValue({ object: { inferredEdges: [] } });

    mocks.scopedSession.mockReturnValue(nodeSession);

    const result = await inferSemanticEdges(makeJob());

    expect(result.inferredEdges).toHaveLength(0);
    expect(mocks.upsertInferredEdges).not.toHaveBeenCalled();
  });

  // OXA-2062: both the node-lookup query and the naturalKey→publicId resolve
  // query MATCH by $orgId, but the local params objects previously omitted
  // it, relying entirely on scopedSession()'s auto-injection. This suite
  // mocks scopedSession() directly (no auto-injection), so this bug was
  // invisible until orgId was bound explicitly on both calls.
  it("binds orgId explicitly on both the node-lookup and resolve queries (regression: previously relied solely on scopedSession auto-injection)", async () => {
    const nodeSession = makeSession({
      records: [
        { get: (k: string) => ({ naturalKey: "github:conn-1:42", displayName: "Task A" })[k] },
      ],
    });
    mocks.generateObjectFor.mockResolvedValue({
      object: {
        inferredEdges: [
          { targetNaturalKey: "github:conn-1:55", edgeType: "PART_OF", confidence: 0.9, rationale: "x" },
        ],
      },
    });
    const resolveSession = makeSession({
      records: [
        { get: (k: string) => ({ naturalKey: "github:conn-1:55", nodeId: "target-node-id" })[k] },
      ],
    });

    let callCount = 0;
    mocks.scopedSession.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? nodeSession : resolveSession;
    });

    await inferSemanticEdges(makeJob({ orgId: "org-oxa-2062" }));

    const nodeParams = nodeSession.run.mock.calls[0]![1] as Record<string, unknown>;
    expect(nodeParams.orgId).toBe("org-oxa-2062");

    const resolveParams = resolveSession.run.mock.calls[0]![1] as Record<string, unknown>;
    expect(resolveParams.orgId).toBe("org-oxa-2062");
  });

  it("closes all sessions (no session leak)", async () => {
    const nodeSession = makeSession({
      records: [
        { get: (k: string) => ({ naturalKey: "github:conn-1:42", displayName: "Task A" })[k] },
      ],
    });
    mocks.generateObjectFor.mockResolvedValue({ object: { inferredEdges: [] } });
    mocks.scopedSession.mockReturnValue(nodeSession);

    await inferSemanticEdges(makeJob());

    expect(nodeSession.close).toHaveBeenCalled();
  });
});
