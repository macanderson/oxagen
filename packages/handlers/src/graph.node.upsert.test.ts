/**
 * graph.node.upsert handler tests.
 *
 * Strategy: mock scopedSession() so no real Neo4j connection is required.
 * Verify:
 *   - MERGE uses naturalKey derived from externalId when provided
 *   - MERGE falls back to label+displayName+workspaceId when no externalId
 *   - Returns nodeId and created=true on create, created=false on match
 *   - Throws when MERGE returns no record
 *   - JSON-encodes properties before passing to Cypher
 *   - Calls embedText with executionStepId: null (billing correctness)
 *   - Stores embedding on node after upsert
 *   - Upsert still succeeds when embedText throws
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => undefined),
  embedText: vi.fn(),
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: () => ({ run: mocks.run, close: mocks.close }),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: async (
    _scope: unknown,
    fn: () => Promise<void>,
  ) => fn(),
}));

vi.mock("@oxagen/ai", () => ({
  embedText: mocks.embedText,
}));

import { graphNodeUpsertHandler } from "./graph.node.upsert";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeRecord(nodeId: string, wasCreated: boolean) {
  return {
    records: [
      {
        get: (key: string) => {
          if (key === "nodeId") return nodeId;
          if (key === "wasCreated") return wasCreated;
          return null;
        },
      },
    ],
  };
}

const VECTOR = new Array(1536).fill(0.5);

// ── setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mocks.run.mockResolvedValue(makeRecord("node-uuid-1", true));
  mocks.embedText.mockResolvedValue(VECTOR);
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("graphNodeUpsertHandler", () => {
  it("returns nodeId and created=true on node creation", async () => {
    mocks.run.mockResolvedValueOnce(makeRecord("node-uuid-1", true));
    const result = await graphNodeUpsertHandler(
      { label: "Person", displayName: "Alice" },
      CTX,
    );
    expect(result.nodeId).toBe("node-uuid-1");
    expect(result.created).toBe(true);
  });

  it("PascalCases the domain label and the `label` display property", async () => {
    mocks.run.mockResolvedValueOnce(makeRecord("node-uuid-1", true));
    await graphNodeUpsertHandler({ label: "pull_request", displayName: "PR #1" }, CTX);

    const [cypher, params] = mocks.run.mock.calls[0] as [string, Record<string, unknown>];
    // Structural Neo4j label is applied PascalCase…
    expect(cypher).toContain("SET n:PullRequest");
    // …and the display property mirrors it (not the raw "pull_request").
    expect(params["label"]).toBe("PullRequest");
  });

  it("returns created=false when node already exists", async () => {
    mocks.run.mockResolvedValueOnce(makeRecord("node-uuid-existing", false));
    const result = await graphNodeUpsertHandler(
      { label: "Company", displayName: "Acme Inc" },
      CTX,
    );
    expect(result.nodeId).toBe("node-uuid-existing");
    expect(result.created).toBe(false);
  });

  it("uses ext: prefix in naturalKey when externalId is provided", async () => {
    await graphNodeUpsertHandler(
      { label: "Person", displayName: "Bob", externalId: "ext-bob-123" },
      CTX,
    );
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.naturalKey).toBe(`ext:${CTX.workspaceId}:ext-bob-123`);
  });

  it("scopes the MERGE key by both orgId and workspaceId", async () => {
    await graphNodeUpsertHandler({ label: "Person", displayName: "Grace" }, CTX);
    const cypher = mocks.run.mock.calls[0]?.[0] as string;
    expect(cypher).toContain(
      "MERGE (n:GraphNode {naturalKey: $naturalKey, orgId: $orgId, workspaceId: $workspaceId})",
    );
  });

  // OXA-2062: the MERGE Cypher referenced $orgId/$workspaceId but the local
  // params object omitted both, relying entirely on scopedSession()'s
  // auto-injection. A mocked scopedSession (as used here) does NOT
  // auto-inject, so this defect class would be invisible to this test suite
  // until orgId/workspaceId were bound explicitly in the handler.
  it("binds orgId and workspaceId explicitly in the MERGE params (regression: previously relied solely on scopedSession auto-injection)", async () => {
    await graphNodeUpsertHandler({ label: "Person", displayName: "Grace" }, CTX);
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.orgId).toBe(CTX.orgId);
    expect(params.workspaceId).toBe(CTX.workspaceId);
  });

  it("uses label+displayName+workspaceId as naturalKey when no externalId", async () => {
    await graphNodeUpsertHandler(
      { label: "Topic", displayName: "TypeScript" },
      CTX,
    );
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.naturalKey).toBe(`Topic:TypeScript:${CTX.workspaceId}`);
  });

  it("JSON-encodes properties before passing to Cypher", async () => {
    await graphNodeUpsertHandler(
      {
        label: "Person",
        displayName: "Carol",
        properties: { role: "engineer", level: 5 },
      },
      CTX,
    );
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(typeof params.properties).toBe("string");
    expect(JSON.parse(params.properties as string)).toEqual({ role: "engineer", level: 5 });
  });

  it("passes null for properties when none provided", async () => {
    await graphNodeUpsertHandler({ label: "Person", displayName: "Dave" }, CTX);
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.properties).toBeNull();
  });

  it("passes description to Cypher", async () => {
    await graphNodeUpsertHandler(
      { label: "Topic", displayName: "Neo4j", description: "Graph database" },
      CTX,
    );
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.description).toBe("Graph database");
  });

  it("promotes the label to a real Neo4j domain label and defaults is_system to false", async () => {
    await graphNodeUpsertHandler({ label: "Person", displayName: "Heidi" }, CTX);
    const cypher = mocks.run.mock.calls[0]?.[0] as string;
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(cypher).toContain("SET n:Person");
    expect(cypher).toContain("n.is_system    = $isSystem");
    expect(params.isSystem).toBe(false);
  });

  it("sanitizes an unsafe label before interpolating it as a Neo4j label", async () => {
    await graphNodeUpsertHandler(
      { label: "Nuclear-powered submarine", displayName: "Nautilus" },
      CTX,
    );
    const cypher = mocks.run.mock.calls[0]?.[0] as string;
    // Hyphens/spaces are tokenised and Title-cased into one PascalCase label;
    // no raw metacharacters reach Cypher.
    expect(cypher).toContain("SET n:NuclearPoweredSubmarine");
    expect(cypher).not.toContain("Nuclear-powered submarine");
  });

  it("honors an explicit isSystem=true for product-owned nodes", async () => {
    await graphNodeUpsertHandler(
      { label: "Execution", displayName: "run-1", isSystem: true },
      CTX,
    );
    const params = mocks.run.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.isSystem).toBe(true);
  });

  it("throws when MERGE returns no record", async () => {
    mocks.run.mockResolvedValueOnce({ records: [] });
    await expect(
      graphNodeUpsertHandler({ label: "Person", displayName: "Eve" }, CTX),
    ).rejects.toThrow("graph.node.upsert: MERGE returned no record");
  });

  it("closes the session even when run throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(
      graphNodeUpsertHandler({ label: "Person", displayName: "Frank" }, CTX),
    ).rejects.toThrow("Neo4j down");
    expect(mocks.close).toHaveBeenCalled();
  });

  // ── embedding tests ────────────────────────────────────────────────────────

  it("calls embedText after upsert with executionStepId: null", async () => {
    await graphNodeUpsertHandler({ label: "Person", displayName: "Alice" }, CTX);
    expect(mocks.embedText).toHaveBeenCalledTimes(1);
    const opts = mocks.embedText.mock.calls[0]![1] as {
      telemetry: { executionStepId: unknown; orgId: string; workspaceId: string; surface: string };
    };
    expect(opts.telemetry.executionStepId).toBeNull();
    expect(opts.telemetry.orgId).toBe(CTX.orgId);
    expect(opts.telemetry.workspaceId).toBe(CTX.workspaceId);
    expect(opts.telemetry.surface).toBe("app");
  });

  it("stores the embedding on the node via a second session.run call", async () => {
    await graphNodeUpsertHandler({ label: "Person", displayName: "Bob" }, CTX);
    // First call = MERGE, second call = SET n.embedding
    expect(mocks.run).toHaveBeenCalledTimes(2);
    const embedCypher = mocks.run.mock.calls[1]![0] as string;
    const embedParams = mocks.run.mock.calls[1]![1] as Record<string, unknown>;
    expect(embedCypher).toContain("SET n.embedding = $embedding");
    expect(embedCypher).toContain("n.embeddingUpdatedAt = datetime()");
    expect(embedParams.embedding).toEqual(VECTOR);
    // OXA-2062: this second session.run() MATCHes by $orgId but historically
    // never bound it locally, relying solely on scopedSession auto-injection.
    expect(embedParams.orgId).toBe(CTX.orgId);
  });

  it("upsert still succeeds when embedText throws (embedding is best-effort)", async () => {
    mocks.embedText.mockRejectedValueOnce(new Error("AI gateway down"));
    const result = await graphNodeUpsertHandler(
      { label: "Person", displayName: "Carol" },
      CTX,
    );
    // The upsert itself must still return normally.
    expect(result.nodeId).toBe("node-uuid-1");
    expect(result.created).toBe(true);
  });

  it("includes label, displayName, and description in the embedding text", async () => {
    await graphNodeUpsertHandler(
      { label: "Topic", displayName: "TypeScript", description: "Typed superset of JS" },
      CTX,
    );
    const embeddingText = mocks.embedText.mock.calls[0]![0] as string;
    expect(embeddingText).toContain("Topic");
    expect(embeddingText).toContain("TypeScript");
    expect(embeddingText).toContain("Typed superset of JS");
  });
});
