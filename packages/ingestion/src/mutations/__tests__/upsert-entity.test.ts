import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  sessionRun: vi.fn(),
  sessionClose: vi.fn().mockResolvedValue(undefined),
  scopedSession: vi.fn(),
  chInsert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: mocks.scopedSession,
}));

vi.mock("@oxagen/telemetry", () => ({
  chInsert: mocks.chInsert,
}));

mocks.scopedSession.mockReturnValue({
  run: mocks.sessionRun,
  close: mocks.sessionClose,
});

import {
  upsertEntityNode,
  upsertEmbedding,
  createAliasEdge,
  upsertInferredEdges,
} from "../upsert-entity";
import type { EntityMutation } from "../../types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMutation(overrides: Partial<EntityMutation> = {}): EntityMutation {
  return {
    workspaceId: "ws-1",
    orgId: "org-1",
    connectionId: "conn-1",
    entityType: "task",
    sourceRecordType: "issue",
    naturalKey: "github:conn-1:42",
    operation: "insert",
    displayName: "Fix the bug",
    properties: { title: "Fix the bug", state: "open" },
    sourceRef: { connectorType: "github", connectionId: "conn-1", externalId: "42" },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("upsertEntityNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopedSession.mockReturnValue({
      run: mocks.sessionRun,
      close: mocks.sessionClose,
    });
  });

  it("runs a MERGE Cypher with naturalKey and orgId", async () => {
    mocks.sessionRun.mockResolvedValueOnce({
      records: [{ get: vi.fn().mockReturnValue("uuid-node-1") }],
    });

    const mutation = makeMutation();
    const result = await upsertEntityNode(mutation, "org-1");

    expect(result.nodeId).toBe("uuid-node-1");
    expect(mocks.sessionRun).toHaveBeenCalledOnce();

    const [cypher, params] = mocks.sessionRun.mock.calls[0] as [string, Record<string, unknown>];
    // §3.3 dual-write: the real label (`task`) is PRIMARY, `:EntityNode` secondary.
    expect(cypher).toContain("MERGE (n:`task`:`EntityNode`");
    expect(cypher).toContain("naturalKey:");
    expect(cypher).toContain("orgId:");
    expect(cypher).toContain("RETURN n.publicId AS nodeId");
    expect(params["naturalKey"]).toBe("github:conn-1:42");
    expect(params["entityType"]).toBe("task");
    expect(params["displayName"]).toBe("Fix the bug");
    // properties must be JSON-stringified
    expect(typeof params["properties"]).toBe("string");
    expect(JSON.parse(params["properties"] as string)).toMatchObject({ title: "Fix the bug" });
  });

  it("also sets the :GraphNode anchor label + graph display fields so the node is visible in the explorer", async () => {
    // Regression: ingestion wrote only :EntityNode while every graph read
    // (graph.node.list/search/stats, ontology.neighbors) matches the
    // :GraphNode anchor — so ingested entities were invisible in the graph UI.
    mocks.sessionRun.mockResolvedValueOnce({
      records: [{ get: vi.fn().mockReturnValue("uuid-node-1") }],
    });

    const [cypher, params] = await (async () => {
      await upsertEntityNode(makeMutation(), "org-1");
      return mocks.sessionRun.mock.calls[0] as [string, Record<string, unknown>];
    })();

    // The universal anchor label is added on every write.
    expect(cypher).toContain("n:GraphNode");
    // The read layer reads n.label / n.displayName / n.sourceId.
    expect(cypher).toContain("n.label");
    expect(cypher).toContain("n.sourceId");
    expect(params["label"]).toBe("task"); // label = entityType
    expect(params["displayName"]).toBe("Fix the bug");
    expect(params["connectionId"]).toBe("conn-1"); // becomes n.sourceId
  });

  it("falls back displayName to naturalKey when the connector supplied none (never null in the graph)", async () => {
    mocks.sessionRun.mockResolvedValueOnce({
      records: [{ get: vi.fn().mockReturnValue("uuid-node-2") }],
    });

    await upsertEntityNode(makeMutation({ displayName: undefined }), "org-1");
    const [, params] = mocks.sessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(params["displayName"]).toBe("github:conn-1:42");
  });

  it("closes session even on error", async () => {
    mocks.sessionRun.mockRejectedValueOnce(new Error("Neo4j down"));

    await expect(upsertEntityNode(makeMutation(), "org-1")).rejects.toThrow("Neo4j down");
    expect(mocks.sessionClose).toHaveBeenCalledOnce();
  });

  it("throws when no record is returned", async () => {
    mocks.sessionRun.mockResolvedValueOnce({ records: [] });

    await expect(upsertEntityNode(makeMutation(), "org-1")).rejects.toThrow(
      "upsertEntityNode: no record returned",
    );
  });
});

// ── §8 enforcement-mode branches (strict / lenient / off) ────────────────────

import type { PinnedSchema } from "../../validate/schema";

/** A pinned schema requiring a `title` property on the `task` label. */
function pinnedSchema(mode: PinnedSchema["enforcementMode"], floor = 0.5): PinnedSchema {
  return {
    registryId: "scr_1",
    versionId: "scv_42",
    versionNumber: 1,
    enforcementMode: mode,
    conformanceFloor: floor,
    labels: [
      {
        schemaName: "starter",
        name: "task",
        displayName: "Task",
        description: "a unit of work",
        naturalKeyProps: [],
        properties: [
          {
            key: "title",
            dataType: "string",
            required: true,
            description: "the task title",
            enumValues: null,
            itemType: null,
            constraints: {},
            example: null,
          },
        ],
      },
    ],
    relationshipTypes: [],
  };
}

describe("upsertEntityNode — §8 enforcement modes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopedSession.mockReturnValue({
      run: mocks.sessionRun,
      close: mocks.sessionClose,
    });
    mocks.sessionRun.mockResolvedValue({
      records: [{ get: vi.fn().mockReturnValue("uuid-node-1") }],
    });
  });

  it("strict: a missing-required write is REJECTED (no MERGE) with reason schema_nonconformant", async () => {
    // `properties` lacks the required `title` → non-conformant.
    const mutation = makeMutation({ properties: { state: "open" } });
    const result = await upsertEntityNode(mutation, "org-1", {
      pinnedSchema: pinnedSchema("strict"),
    });

    expect(result.nodeId).toBeNull();
    expect(result.rejected).toBe(true);
    expect(result.reason).toBe("schema_nonconformant");
    // No MERGE ran — the node was not written.
    expect(mocks.sessionRun).not.toHaveBeenCalled();
    // A rejected conformance event was emitted.
    const chCalls = mocks.chInsert.mock.calls;
    expect(chCalls.some(([table]) => table === "schema_conformance_events")).toBe(true);
  });

  it("lenient: a non-conformant write IS written + scored + stamped with the version id", async () => {
    const mutation = makeMutation({ properties: { state: "open" } });
    const result = await upsertEntityNode(mutation, "org-1", {
      pinnedSchema: pinnedSchema("lenient"),
    });

    expect(result.nodeId).toBe("uuid-node-1");
    expect(typeof result.conformanceScore).toBe("number");
    expect(result.conformanceScore).toBeLessThan(1); // missing required → < 1
    // The MERGE ran and stamped conformance props.
    const params = mocks.sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params["conformanceScore"]).toBe(result.conformanceScore);
    expect(params["schemaVersionId"]).toBe("scv_42");
    // observed-label + conformance events emitted.
    const tables = mocks.chInsert.mock.calls.map(([t]) => t);
    expect(tables).toContain("graph_observed_labels");
    expect(tables).toContain("schema_conformance_events");
  });

  it("off: validation is skipped entirely (write proceeds, no conformance props)", async () => {
    const mutation = makeMutation({ properties: { state: "open" } });
    const result = await upsertEntityNode(mutation, "org-1", {
      pinnedSchema: pinnedSchema("off"),
    });

    expect(result.nodeId).toBe("uuid-node-1");
    expect(result.conformanceScore).toBeUndefined();
    const params = mocks.sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    // No schema evaluated → conformance props are null (not stamped).
    expect(params["conformanceScore"]).toBeNull();
    expect(params["schemaVersionId"]).toBeNull();
    // No conformance event (off skips validation); observed-label still emitted.
    const tables = mocks.chInsert.mock.calls.map(([t]) => t);
    expect(tables).not.toContain("schema_conformance_events");
    expect(tables).toContain("graph_observed_labels");
  });
});

describe("upsertEmbedding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopedSession.mockReturnValue({
      run: mocks.sessionRun,
      close: mocks.sessionClose,
    });
    mocks.sessionRun.mockResolvedValue({ records: [] });
  });

  it("runs MATCH + SET Cypher on publicId", async () => {
    await upsertEmbedding("node-uuid", [0.1, 0.2, 0.3], "text-embedding-3-small", "org-1");

    expect(mocks.sessionRun).toHaveBeenCalledOnce();
    const [cypher, params] = mocks.sessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(cypher).toContain("MATCH (n:EntityNode {publicId: $nodeId, orgId: $orgId})");
    expect(cypher).toContain("SET n.embedding");
    expect(params["nodeId"]).toBe("node-uuid");
    expect(params["vector"]).toEqual([0.1, 0.2, 0.3]);
    expect(params["model"]).toBe("text-embedding-3-small");
  });

  it("closes session on success", async () => {
    await upsertEmbedding("node-uuid", [], "model", "org-1");
    expect(mocks.sessionClose).toHaveBeenCalledOnce();
  });
});

describe("createAliasEdge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopedSession.mockReturnValue({
      run: mocks.sessionRun,
      close: mocks.sessionClose,
    });
    mocks.sessionRun.mockResolvedValue({ records: [] });
  });

  it("runs MERGE ALIAS_OF with correct params", async () => {
    await createAliasEdge("alias-id", "principal-id", {
      confidence: 0.95,
      matchReason: "email_match",
      tentative: false,
    }, "org-1");

    expect(mocks.sessionRun).toHaveBeenCalledOnce();
    const [cypher, params] = mocks.sessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(cypher).toContain("MERGE (alias)-[r:ALIAS_OF]->(principal)");
    expect(params["aliasNodeId"]).toBe("alias-id");
    expect(params["principalNodeId"]).toBe("principal-id");
    expect(params["confidence"]).toBe(0.95);
    expect(params["matchReason"]).toBe("email_match");
    expect(params["tentative"]).toBe(false);
  });
});

describe("upsertInferredEdges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopedSession.mockReturnValue({
      run: mocks.sessionRun,
      close: mocks.sessionClose,
    });
    mocks.sessionRun.mockResolvedValue({ records: [] });
  });

  it("does nothing when edges array is empty", async () => {
    await upsertInferredEdges([], "org-1");
    expect(mocks.scopedSession).not.toHaveBeenCalled();
    expect(mocks.sessionRun).not.toHaveBeenCalled();
  });

  it("runs one MERGE per edge with correct params", async () => {
    const edges = [
      { fromNodeId: "from-1", toNodeId: "to-1", edgeType: "REFERENCES", confidence: 0.8 },
      { fromNodeId: "from-1", toNodeId: "to-2", edgeType: "PART_OF", confidence: 0.9 },
    ];

    await upsertInferredEdges(edges, "org-1");

    expect(mocks.sessionRun).toHaveBeenCalledTimes(2);

    const [cypher1, params1] = mocks.sessionRun.mock.calls[0] as [string, Record<string, unknown>];
    expect(cypher1).toContain("REFERENCES");
    expect(params1["fromNodeId"]).toBe("from-1");
    expect(params1["toNodeId"]).toBe("to-1");
    expect(params1["confidence"]).toBe(0.8);

    const [cypher2] = mocks.sessionRun.mock.calls[1] as [string, Record<string, unknown>];
    expect(cypher2).toContain("PART_OF");
  });

  it("supports all 4 allowed edge types", async () => {
    const edgeTypes = ["INFERRED_FROM", "REFERENCES", "SIMILAR_TO", "PART_OF"];
    for (const edgeType of edgeTypes) {
      vi.clearAllMocks();
      mocks.scopedSession.mockReturnValue({
        run: mocks.sessionRun,
        close: mocks.sessionClose,
      });
      mocks.sessionRun.mockResolvedValue({ records: [] });

      await upsertInferredEdges(
        [{ fromNodeId: "from", toNodeId: "to", edgeType, confidence: 0.7 }],
        "org-1",
      );
      const [cypher] = mocks.sessionRun.mock.calls[0] as [string, unknown];
      expect(cypher).toContain(edgeType);
    }
  });

  it("throws for unsupported edge types", async () => {
    await expect(
      upsertInferredEdges(
        [{ fromNodeId: "f", toNodeId: "t", edgeType: "UNKNOWN_EDGE", confidence: 0.5 }],
        "org-1",
      ),
    ).rejects.toThrow('unsupported edgeType "UNKNOWN_EDGE"');
  });

  it("closes session on success", async () => {
    await upsertInferredEdges(
      [{ fromNodeId: "f", toNodeId: "t", edgeType: "SIMILAR_TO", confidence: 0.75 }],
      "org-1",
    );
    expect(mocks.sessionClose).toHaveBeenCalledOnce();
  });
});
