import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  sessionRun: vi.fn(),
  sessionClose: vi.fn().mockResolvedValue(undefined),
  scopedSession: vi.fn(),
  embedText: vi.fn(),
  upsertEntityNode: vi.fn(),
  createAliasEdge: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: mocks.scopedSession,
}));

vi.mock("@oxagen/ai", () => ({
  embedText: mocks.embedText,
}));

vi.mock("../../mutations/upsert-entity", () => ({
  upsertEntityNode: mocks.upsertEntityNode,
  createAliasEdge: mocks.createAliasEdge,
}));

import { resolveEntity, scoreCandidate, fuzzyNameScore } from "../resolve";
import type { EntityMutation } from "../../types";
import { ALIAS_THRESHOLD, CONFIRM_THRESHOLD } from "../../types";

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
    displayName: "Add OAuth Login",
    properties: { title: "Add OAuth Login", state: "open" },
    sourceRef: {
      connectorType: "github",
      connectionId: "conn-1",
      externalId: "42",
    },
    ...overrides,
  };
}

function mockSessionReturning(records: Array<Record<string, unknown>>) {
  mocks.scopedSession.mockReturnValue({
    run: mocks.sessionRun,
    close: mocks.sessionClose,
  });
  mocks.sessionRun.mockResolvedValue({
    records: records.map((r) => ({ get: (k: string) => r[k] })),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("resolveEntity — Pass A: exact naturalKey hit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAliasEdge.mockResolvedValue(undefined);
    mocks.upsertEntityNode.mockResolvedValue({ nodeId: "existing-node-id" });
  });

  it("returns updated_principal when Pass A finds the node", async () => {
    // Pass A session returns a record
    mockSessionReturning([{ nodeId: "existing-node-id" }]);

    const result = await resolveEntity(makeMutation(), "org-1");

    expect(result.action).toBe("updated_principal");
    expect(result.principalNodeId).toBe("existing-node-id");
    expect(result.confidence).toBe(1.0);
    expect(result.matchReason).toBe("natural_key_exact");
  });

  it("calls upsertEntityNode to update the existing node on Pass A hit", async () => {
    mockSessionReturning([{ nodeId: "existing-node-id" }]);

    await resolveEntity(makeMutation(), "org-1");

    expect(mocks.upsertEntityNode).toHaveBeenCalledOnce();
    expect(mocks.embedText).not.toHaveBeenCalled();
  });

  it("closes the session after Pass A", async () => {
    mockSessionReturning([{ nodeId: "existing-node-id" }]);

    await resolveEntity(makeMutation(), "org-1");

    expect(mocks.sessionClose).toHaveBeenCalled();
  });

  it("passes orgId in the Pass A query parameters (regression: missing orgId caused permanent cache miss)", async () => {
    // This test guards against the bug where orgId was absent from Pass A params,
    // causing Neo4j to evaluate `orgId = null` and always return no records.
    mockSessionReturning([{ nodeId: "existing-node-id" }]);

    await resolveEntity(makeMutation(), "org-42");

    expect(mocks.sessionRun).toHaveBeenCalledWith(
      expect.stringContaining("orgId: $orgId"),
      expect.objectContaining({
        orgId: "org-42",
        naturalKey: "github:conn-1:42",
      }),
    );
  });
});

describe("resolveEntity — Pass B: no natural key match → new principal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAliasEdge.mockResolvedValue(undefined);
    mocks.upsertEntityNode.mockResolvedValue({ nodeId: "new-node-id" });
    mocks.embedText.mockResolvedValue(new Array(1536).fill(0.1));
  });

  it("creates a new principal when no similar nodes found", async () => {
    // Pass A: miss; Pass B: no candidates
    let callCount = 0;
    mocks.scopedSession.mockImplementation(() => {
      callCount++;
      return { run: mocks.sessionRun, close: mocks.sessionClose };
    });
    // First call = Pass A (miss), second call = vector search (no results), third = batch resolve (empty)
    mocks.sessionRun.mockResolvedValue({ records: [] });

    const result = await resolveEntity(makeMutation(), "org-1");

    expect(result.action).toBe("created_principal");
    expect(mocks.embedText).toHaveBeenCalledOnce();
    expect(mocks.upsertEntityNode).toHaveBeenCalledOnce();
    expect(mocks.createAliasEdge).not.toHaveBeenCalled();
  });

  it("passes orgId in the Pass B vector query parameters (regression: missing orgId caused all candidates to be filtered out)", async () => {
    // Guards against the bug where orgId was absent from Pass B params, causing
    // the WHERE clause `n.orgId = $orgId` to evaluate as `n.orgId = null` and
    // filter out every vector search candidate.
    mocks.scopedSession.mockReturnValue({
      run: mocks.sessionRun,
      close: mocks.sessionClose,
    });
    // First call = Pass A (miss), second call = Pass B vector search (no results)
    mocks.sessionRun
      .mockResolvedValueOnce({ records: [] }) // Pass A miss
      .mockResolvedValueOnce({ records: [] }); // Pass B no candidates
    const mutation = makeMutation();

    await resolveEntity(mutation, "org-99");

    // The second session.run call is the vector search — verify orgId is present
    const secondCall = mocks.sessionRun.mock.calls[1];
    expect(secondCall).toBeDefined();
    const secondParams = secondCall![1] as Record<string, unknown>;
    expect(secondParams["orgId"]).toBe("org-99");
    expect(secondParams["entityType"]).toBe(mutation.entityType);
  });

  it("over-fetches the entity index (k=candidateLimit×3) but trims to candidateLimit after tenant/type filtering", async () => {
    mocks.scopedSession.mockReturnValue({
      run: mocks.sessionRun,
      close: mocks.sessionClose,
    });
    mocks.sessionRun
      .mockResolvedValueOnce({ records: [] }) // Pass A miss
      .mockResolvedValueOnce({ records: [] }); // Pass B no candidates

    await resolveEntity(makeMutation(), "org-1");

    const secondCall = mocks.sessionRun.mock.calls[1];
    expect(secondCall).toBeDefined();
    const cypher = String(secondCall![0]);
    // Index is queried with the over-sampled $k, then trimmed via LIMIT $limit
    // after the org/entityType filter so the tenant filter can't starve dedup.
    expect(cypher).toContain(
      "db.index.vector.queryNodes('entity_node_embedding_index', $k",
    );
    expect(cypher).toContain("LIMIT $limit");
    const params = secondCall![1] as Record<string, unknown>;
    expect(params["k"]).toBe(BigInt(15)); // CANDIDATE_LIMIT(5) × 3
    expect(params["limit"]).toBe(BigInt(5));
  });

  it("passes correct telemetry to embedText", async () => {
    mocks.scopedSession.mockReturnValue({
      run: mocks.sessionRun,
      close: mocks.sessionClose,
    });
    mocks.sessionRun.mockResolvedValue({ records: [] });
    const mutation = makeMutation();

    await resolveEntity(mutation, "org-1");

    expect(mocks.embedText).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        telemetry: expect.objectContaining({
          orgId: "org-1",
          workspaceId: "ws-1",
          surface: "ingestion",
          // No execution step for dedup embeds → null, never a synthesized
          // `dedup:<naturalKey>` string. The non-UUID value broke the ClickHouse
          // token_usage UUID insert and the Postgres uuid credit charge.
          executionStepId: null,
        }),
      }),
    );
  });
});

describe("resolveEntity — Pass B: alias path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAliasEdge.mockResolvedValue(undefined);
    mocks.upsertEntityNode.mockResolvedValue({ nodeId: "alias-node-id" });
    mocks.embedText.mockResolvedValue(new Array(1536).fill(0.1));
  });

  it("creates alias when a candidate is above ALIAS_THRESHOLD", async () => {
    // Use separate session mocks for each scopedSession() call.
    // resolveEntity calls scopedSession() three times:
    //   1st = Pass A MATCH (returns nothing)
    //   2nd = Pass B vector search (returns one high-score candidate)
    //   3rd = batch naturalKey resolve (returns nothing — target not needed for edge creation)
    const passASession = {
      run: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    // Pass B: return one high-score candidate (cosine=0.95 gives 0.38; + displayName name similarity ≈ 0.14 → total ≈ 0.52 < 0.70)
    // Use email match to push above threshold: 0.95*0.4=0.38 + 0.4 email + 0.2*name ≈ 0.78 → above ALIAS_THRESHOLD
    const mutation = makeMutation({
      displayName: "Add OAuth Login",
      properties: { email: "mac@example.com" },
    });
    const passBSession = {
      run: vi.fn().mockResolvedValue({
        records: [
          {
            get: (k: string) =>
              ({
                nodeId: "principal-id",
                displayName: "Add OAuth Login",
                properties: JSON.stringify({ email: "mac@example.com" }),
                score: 0.95,
              })[k],
          },
        ],
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const resolveSession = {
      run: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    let sessionCallCount = 0;
    mocks.scopedSession.mockImplementation(() => {
      sessionCallCount++;
      if (sessionCallCount === 1) return passASession;
      if (sessionCallCount === 2) return passBSession;
      return resolveSession;
    });

    const result = await resolveEntity(mutation, "org-1");

    expect(["created_alias", "confirmed_alias"]).toContain(result.action);
    expect(result.principalNodeId).toBe("principal-id");
    expect(result.aliasNodeId).toBe("alias-node-id");
    expect(mocks.createAliasEdge).toHaveBeenCalledOnce();
  });

  it("creates a new principal when combined score is below ALIAS_THRESHOLD", async () => {
    // cosine=0.5 with no email/url/name match → 0.5 * 0.4 = 0.2 < ALIAS_THRESHOLD (0.70)
    const passASession = {
      run: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const passBSession = {
      run: vi.fn().mockResolvedValue({
        records: [
          {
            get: (k: string) =>
              ({
                nodeId: "candidate-id",
                displayName: "Completely Different Name",
                properties: null,
                score: 0.5,
              })[k],
          },
        ],
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const resolveSession = {
      run: vi.fn().mockResolvedValue({ records: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    let sessionCallCount = 0;
    mocks.scopedSession.mockImplementation(() => {
      sessionCallCount++;
      if (sessionCallCount === 1) return passASession;
      if (sessionCallCount === 2) return passBSession;
      return resolveSession;
    });

    const mutation = makeMutation({
      displayName: "Something Unrelated",
      properties: {},
    });
    const result = await resolveEntity(mutation, "org-1");

    // score = 0.5 * 0.4 = 0.2 < 0.70 → no alias, should create_principal
    expect(result.action).toBe("created_principal");
    expect(mocks.createAliasEdge).not.toHaveBeenCalled();
  });
});

describe("scoreCandidate", () => {
  const baseMutation = makeMutation();

  it("uses 0.4 weight for embedding similarity", () => {
    const score = scoreCandidate(baseMutation, {}, 1.0);
    // No email/url match, no display names → 1.0 * 0.4 = 0.4
    expect(score).toBeCloseTo(0.4, 5);
  });

  it("adds 0.4 for exact email match", () => {
    const mutation = makeMutation({ properties: { email: "mac@example.com" } });
    const score = scoreCandidate(mutation, { email: "mac@example.com" }, 0.5);
    // 0.5*0.4 + 0.4 = 0.6
    expect(score).toBeCloseTo(0.6, 5);
  });

  it("adds 0.4 for exact URL match", () => {
    const mutation = makeMutation({
      properties: { url: "https://example.com/pr/1" },
    });
    const score = scoreCandidate(
      mutation,
      { url: "https://example.com/pr/1" },
      0.5,
    );
    expect(score).toBeCloseTo(0.6, 5);
  });

  it("adds fuzzy name weight when displayNames are present", () => {
    const mutation = makeMutation({ displayName: "Add OAuth Login" });
    const score = scoreCandidate(
      mutation,
      { displayName: "Add OAuth Login" },
      0.0,
    );
    // 0 + 0 + 1.0 * 0.2 = 0.2
    expect(score).toBeCloseTo(0.2, 5);
  });

  it("caps score at 1.0", () => {
    const mutation = makeMutation({
      displayName: "Match",
      properties: { email: "a@b.com" },
    });
    const score = scoreCandidate(
      mutation,
      { displayName: "Match", email: "a@b.com" },
      1.0,
    );
    expect(score).toBeLessThanOrEqual(1.0);
  });
});

describe("fuzzyNameScore", () => {
  it("returns 1.0 for identical strings", () => {
    expect(fuzzyNameScore("Mac Anderson", "Mac Anderson")).toBe(1);
  });

  it("returns 0 or near-0 for completely different strings", () => {
    expect(fuzzyNameScore("Mac Anderson", "John Smith")).toBeLessThan(0.3);
  });

  it("is case-insensitive", () => {
    expect(fuzzyNameScore("MAC ANDERSON", "mac anderson")).toBe(1);
  });

  it("handles empty strings gracefully", () => {
    expect(fuzzyNameScore("", "")).toBe(1);
  });
});

describe("threshold constants", () => {
  it("ALIAS_THRESHOLD is 0.70", () => {
    expect(ALIAS_THRESHOLD).toBe(0.7);
  });

  it("CONFIRM_THRESHOLD is 0.92", () => {
    expect(CONFIRM_THRESHOLD).toBe(0.92);
  });
});
