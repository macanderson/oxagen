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

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  // Keep the REAL deterministicEventId (pure, no I/O) so idempotency-key
  // assertions below exercise actual production logic — only chInsert (the
  // I/O boundary) is mocked.
  const actual = await importOriginal<typeof import("@oxagen/telemetry")>();
  return { ...actual, chInsert: mocks.chInsert };
});

mocks.scopedSession.mockReturnValue({
  run: mocks.sessionRun,
  close: mocks.sessionClose,
});

import {
  upsertEntityNode,
  upsertEmbedding,
  createAliasEdge,
  upsertSourceConnectionMeta,
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
    sourceRef: {
      connectorType: "github",
      connectionId: "conn-1",
      externalId: "42",
    },
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

    const [cypher, params] = mocks.sessionRun.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    // §3.3 dual-write: the real label is PRIMARY, `:EntityNode` secondary. The
    // entityType "task" is canonicalised to the PascalCase label `Task`.
    expect(cypher).toContain("MERGE (n:`Task`:`EntityNode`");
    expect(cypher).toContain("naturalKey:");
    expect(cypher).toContain("orgId:");
    expect(cypher).toContain("RETURN n.publicId AS nodeId");
    expect(params["naturalKey"]).toBe("github:conn-1:42");
    expect(params["entityType"]).toBe("task");
    expect(params["displayName"]).toBe("Fix the bug");
    // properties must be JSON-stringified
    expect(typeof params["properties"]).toBe("string");
    expect(JSON.parse(params["properties"] as string)).toMatchObject({
      title: "Fix the bug",
    });
  });

  it("canonicalises a multi-word snake entityType to a PascalCase label, slug kept on entityType", async () => {
    mocks.sessionRun.mockResolvedValueOnce({
      records: [{ get: vi.fn().mockReturnValue("uuid-node-1") }],
    });

    await upsertEntityNode(
      makeMutation({ entityType: "pull_request" }),
      "org-1",
    );

    const [cypher, params] = mocks.sessionRun.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    // Neo4j :Label and the display `label` are PascalCase; the registry slug
    // "pull_request" is preserved verbatim on `entityType`.
    expect(cypher).toContain("MERGE (n:`PullRequest`:`EntityNode`");
    expect(params["label"]).toBe("PullRequest");
    expect(params["entityType"]).toBe("pull_request");
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
      return mocks.sessionRun.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
    })();

    // The universal anchor label is added on every write.
    expect(cypher).toContain("n:GraphNode");
    // The read layer reads n.label / n.displayName / n.sourceId.
    expect(cypher).toContain("n.label");
    expect(cypher).toContain("n.sourceId");
    // The display `label` is the PascalCase form; the lowercase registry slug
    // lives on `entityType` (asserted above), the two intentionally distinct.
    expect(params["label"]).toBe("Task");
    expect(params["displayName"]).toBe("Fix the bug");
    expect(params["connectionId"]).toBe("conn-1"); // becomes n.sourceId
  });

  it("falls back displayName to naturalKey when the connector supplied none (never null in the graph)", async () => {
    mocks.sessionRun.mockResolvedValueOnce({
      records: [{ get: vi.fn().mockReturnValue("uuid-node-2") }],
    });

    await upsertEntityNode(makeMutation({ displayName: undefined }), "org-1");
    const [, params] = mocks.sessionRun.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(params["displayName"]).toBe("github:conn-1:42");
  });

  it("closes session even on error", async () => {
    mocks.sessionRun.mockRejectedValueOnce(new Error("Neo4j down"));

    await expect(upsertEntityNode(makeMutation(), "org-1")).rejects.toThrow(
      "Neo4j down",
    );
    expect(mocks.sessionClose).toHaveBeenCalledOnce();
  });

  it("throws when no record is returned", async () => {
    mocks.sessionRun.mockResolvedValueOnce({ records: [] });

    await expect(upsertEntityNode(makeMutation(), "org-1")).rejects.toThrow(
      "upsertEntityNode: no record returned",
    );
  });

  // OXA-2062: the MERGE key is `{naturalKey: $naturalKey, orgId: $orgId}` but
  // the local params object previously omitted `orgId` entirely (the second
  // constructor arg was named `_orgId` and never threaded through), relying
  // solely on scopedSession()'s auto-injection. This suite mocks
  // scopedSession() directly (no auto-injection), so this bug was invisible
  // until orgId was bound explicitly. This is the same defect class as
  // OXA-2052 (packages/ingestion/src/dedup/resolve.ts), found here in the
  // underlying mutation layer resolve.ts itself calls into.
  it("binds orgId explicitly in the MERGE params (regression: previously relied solely on scopedSession auto-injection)", async () => {
    mocks.sessionRun.mockResolvedValueOnce({
      records: [{ get: vi.fn().mockReturnValue("uuid-node-1") }],
    });

    await upsertEntityNode(makeMutation(), "org-42");

    const [, params] = mocks.sessionRun.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(params["orgId"]).toBe("org-42");
  });

  // ── previousProperties + isNew capture (Phase 2 automation triggers) ────────
  // The MERGE now captures the pre-overwrite state via a WITH between the
  // branches and the main SET, and RETURNs `isNew` + `previousProperties`
  // alongside `nodeId`. A per-key record mock lets us assert the mapping.

  /** A record whose `.get(key)` returns the mapped value (undefined otherwise). */
  function recordFrom(values: Record<string, unknown>) {
    return {
      records: [
        {
          get: vi.fn((key: string) =>
            key in values ? values[key] : undefined,
          ),
        },
      ],
    };
  }

  it("captures pre-overwrite state via a WITH and RETURNs isNew + previousProperties", async () => {
    mocks.sessionRun.mockResolvedValueOnce(
      recordFrom({
        nodeId: "uuid-node-1",
        isNew: true,
        previousProperties: null,
      }),
    );

    await upsertEntityNode(makeMutation(), "org-1");

    const [cypher] = mocks.sessionRun.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    // The scratch flag drives isNew; the WITH reads the OLD properties BEFORE
    // the SET clobbers them; both are returned.
    expect(cypher).toContain("n._isNew           = true");
    expect(cypher).toContain("n._isNew           = false");
    expect(cypher).toContain(
      "WITH n, n._isNew AS isNew, n.properties AS previousProperties",
    );
    expect(cypher).toContain(
      "RETURN n.publicId AS nodeId, isNew, previousProperties",
    );
    // The scratch flag is cleared so it never persists on the node.
    expect(cypher).toContain("n._isNew           = null");
  });

  it("returns isNew=true and previousProperties=null on a create (ON CREATE)", async () => {
    mocks.sessionRun.mockResolvedValueOnce(
      recordFrom({
        nodeId: "uuid-node-1",
        isNew: true,
        previousProperties: null,
      }),
    );

    const result = await upsertEntityNode(makeMutation(), "org-1");

    expect(result.nodeId).toBe("uuid-node-1");
    expect(result.isNew).toBe(true);
    expect(result.previousProperties).toBeNull();
  });

  it("returns isNew=false and the parsed prior JSON object on an update (ON MATCH)", async () => {
    // The stored `n.properties` is a JSON STRING — the OLD state before this
    // write overwrote it. It is JSON.parsed back into an object.
    mocks.sessionRun.mockResolvedValueOnce(
      recordFrom({
        nodeId: "uuid-node-1",
        isNew: false,
        previousProperties: JSON.stringify({
          status: "open",
          title: "Fix the bug",
        }),
      }),
    );

    const result = await upsertEntityNode(makeMutation(), "org-1");

    expect(result.isNew).toBe(false);
    expect(result.previousProperties).toEqual({
      status: "open",
      title: "Fix the bug",
    });
  });

  it("returns previousProperties=null when the stored JSON is malformed (guarded, never throws)", async () => {
    mocks.sessionRun.mockResolvedValueOnce(
      recordFrom({
        nodeId: "uuid-node-1",
        isNew: false,
        previousProperties: "{not valid json",
      }),
    );

    const result = await upsertEntityNode(makeMutation(), "org-1");

    expect(result.previousProperties).toBeNull();
  });
});

// ── §8 enforcement-mode branches (strict / lenient / off) ────────────────────

import type { PinnedSchema } from "../../validate/schema";

/** A pinned schema requiring a `title` property on the `task` label. */
function pinnedSchema(
  mode: PinnedSchema["enforcementMode"],
  floor = 0.5,
): PinnedSchema {
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
    expect(
      chCalls.some(([table]) => table === "schema_conformance_events"),
    ).toBe(true);
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
    const params = mocks.sessionRun.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
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
    const params = mocks.sessionRun.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    // No schema evaluated → conformance props are null (not stamped).
    expect(params["conformanceScore"]).toBeNull();
    expect(params["schemaVersionId"]).toBeNull();
    // No conformance event (off skips validation); observed-label still emitted.
    const tables = mocks.chInsert.mock.calls.map(([t]) => t);
    expect(tables).not.toContain("schema_conformance_events");
    expect(tables).toContain("graph_observed_labels");
  });

  // ── OXA-1932: idempotent conformance events under Inngest retries ─────────
  //
  // Regression coverage for the double-counting defect: `event_id` used to be
  // `crypto.randomUUID()`, so a retried Inngest step (which re-executes the
  // WHOLE step.run body, including this ClickHouse insert) minted a brand new
  // row for the exact same logical write. These tests fail on the pre-fix code
  // (every call produces a distinct random event_id) and pass on the fix
  // (event_id is a deterministic function of stable inputs).
  describe("conformance-event idempotency (OXA-1932)", () => {
    function conformanceRows(): Array<Record<string, unknown>> {
      return mocks.chInsert.mock.calls
        .filter(([table]) => table === "schema_conformance_events")
        .flatMap(([, rows]) => rows as Array<Record<string, unknown>>);
    }

    // floor 0 keeps belowFloor false (score 0 is NOT < 0) so exactly ONE
    // conformance row is emitted per call — isolates the primary-row identity
    // tests below from the separate alert-row test further down.
    const singleRowSchema = () => pinnedSchema("lenient", 0);

    it("re-deriving the SAME Inngest runId for a retried write produces the SAME event_id (dedup on replay)", async () => {
      const mutation = makeMutation({ properties: { state: "open" } });
      const opts = { pinnedSchema: singleRowSchema(), runId: "run-abc-123" };

      // First attempt.
      await upsertEntityNode(mutation, "org-1", opts);
      // Simulated Inngest retry: SAME mutation, SAME runId, whole function
      // re-invoked from scratch (exactly what step.run replays on failure).
      vi.clearAllMocks();
      mocks.scopedSession.mockReturnValue({
        run: mocks.sessionRun,
        close: mocks.sessionClose,
      });
      mocks.sessionRun.mockResolvedValue({
        records: [{ get: vi.fn().mockReturnValue("uuid-node-1") }],
      });
      await upsertEntityNode(mutation, "org-1", opts);

      const rows = conformanceRows();
      expect(rows).toHaveLength(1);
      expect(typeof rows[0]!["event_id"]).toBe("string");
      expect(rows[0]!["event_id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("computes the identical event_id across two independent calls given identical inputs (retry simulation without re-clearing mocks)", async () => {
      const mutation = makeMutation({ properties: { state: "open" } });
      const opts = { pinnedSchema: singleRowSchema(), runId: "run-retry-1" };

      await upsertEntityNode(mutation, "org-1", opts);
      const firstEventId = conformanceRows()[0]!["event_id"];

      // Do NOT clear mocks — accumulate a second "retry" call in the same
      // chInsert history and assert both rows share the identical event_id.
      await upsertEntityNode(mutation, "org-1", opts);
      const rows = conformanceRows();
      expect(rows).toHaveLength(2);
      expect(rows[0]!["event_id"]).toBe(firstEventId);
      expect(rows[1]!["event_id"]).toBe(firstEventId);
    });

    it("mints a DIFFERENT event_id when the Inngest runId differs (genuinely separate ingestion, not a retry)", async () => {
      const mutation = makeMutation({ properties: { state: "open" } });
      const pinned = singleRowSchema();

      await upsertEntityNode(mutation, "org-1", {
        pinnedSchema: pinned,
        runId: "run-day-1",
      });
      await upsertEntityNode(mutation, "org-1", {
        pinnedSchema: pinned,
        runId: "run-day-2",
      });

      const rows = conformanceRows();
      expect(rows).toHaveLength(2);
      expect(rows[0]!["event_id"]).not.toBe(rows[1]!["event_id"]);
    });

    it("gives the low-conformance alert row a DIFFERENT event_id than the primary written_below_floor row", async () => {
      // conformanceFloor above the actual score forces belowFloor=true, which
      // triggers BOTH the primary outcome row and the alert marker row for
      // the SAME (mutation, versionId, outcome) — they must not collide.
      const mutation = makeMutation({ properties: { state: "open" } });
      const opts = {
        pinnedSchema: pinnedSchema("lenient", 0.99),
        runId: "run-alert-1",
      };

      await upsertEntityNode(mutation, "org-1", opts);

      const rows = conformanceRows();
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r["outcome"] === "written_below_floor")).toBe(
        true,
      );
      expect(rows[0]!["event_id"]).not.toBe(rows[1]!["event_id"]);
    });

    it("retrying a below-floor write reproduces BOTH the primary row's and the alert row's event_id unchanged", async () => {
      const mutation = makeMutation({ properties: { state: "open" } });
      const opts = {
        pinnedSchema: pinnedSchema("lenient", 0.99),
        runId: "run-alert-retry",
      };

      await upsertEntityNode(mutation, "org-1", opts);
      const [firstPrimary, firstAlert] = conformanceRows().map(
        (r) => r["event_id"],
      );

      vi.clearAllMocks();
      mocks.scopedSession.mockReturnValue({
        run: mocks.sessionRun,
        close: mocks.sessionClose,
      });
      mocks.sessionRun.mockResolvedValue({
        records: [{ get: vi.fn().mockReturnValue("uuid-node-1") }],
      });
      await upsertEntityNode(mutation, "org-1", opts);
      const [retryPrimary, retryAlert] = conformanceRows().map(
        (r) => r["event_id"],
      );

      expect(retryPrimary).toBe(firstPrimary);
      expect(retryAlert).toBe(firstAlert);
    });

    it("falls back to a fixed sentinel (not a fresh random id) when no runId is supplied, still deterministic across repeats", async () => {
      const mutation = makeMutation({ properties: { state: "open" } });
      const opts = { pinnedSchema: singleRowSchema() }; // no runId

      await upsertEntityNode(mutation, "org-1", opts);
      await upsertEntityNode(mutation, "org-1", opts);

      const rows = conformanceRows();
      expect(rows).toHaveLength(2);
      expect(rows[0]!["event_id"]).toBe(rows[1]!["event_id"]);
    });
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
    await upsertEmbedding(
      "node-uuid",
      [0.1, 0.2, 0.3],
      "text-embedding-3-small",
      "org-1",
    );

    expect(mocks.sessionRun).toHaveBeenCalledOnce();
    const [cypher, params] = mocks.sessionRun.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(cypher).toContain(
      "MATCH (n:EntityNode {publicId: $nodeId, orgId: $orgId})",
    );
    expect(cypher).toContain("SET n.embedding");
    expect(params["nodeId"]).toBe("node-uuid");
    expect(params["vector"]).toEqual([0.1, 0.2, 0.3]);
    expect(params["model"]).toBe("text-embedding-3-small");
  });

  it("closes session on success", async () => {
    await upsertEmbedding("node-uuid", [], "model", "org-1");
    expect(mocks.sessionClose).toHaveBeenCalledOnce();
  });

  // OXA-2062: the MATCH references $orgId but the local params object
  // previously omitted it, relying solely on scopedSession auto-injection.
  it("binds orgId explicitly in the local params object (regression: previously relied solely on scopedSession auto-injection)", async () => {
    await upsertEmbedding("node-uuid", [0.1], "model", "org-77");
    const [, params] = mocks.sessionRun.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(params["orgId"]).toBe("org-77");
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
    await createAliasEdge(
      "alias-id",
      "principal-id",
      {
        confidence: 0.95,
        matchReason: "email_match",
        tentative: false,
      },
      "org-1",
    );

    expect(mocks.sessionRun).toHaveBeenCalledOnce();
    const [cypher, params] = mocks.sessionRun.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(cypher).toContain("MERGE (alias)-[r:ALIAS_OF]->(principal)");
    expect(params["aliasNodeId"]).toBe("alias-id");
    expect(params["principalNodeId"]).toBe("principal-id");
    expect(params["confidence"]).toBe(0.95);
    expect(params["matchReason"]).toBe("email_match");
    expect(params["tentative"]).toBe(false);
    // Bi-temporal validity stamped on create (validFrom falls back to now).
    expect(cypher).toContain(
      "r.validFrom = coalesce(datetime($validFrom), datetime())",
    );
    expect(cypher).toContain("r.recordedAt = datetime()");
    expect(params["validFrom"]).toBeNull();
  });

  // OXA-2062: both MATCH clauses reference $orgId but the local params object
  // previously omitted it, relying solely on scopedSession auto-injection.
  it("binds orgId explicitly in the local params object (regression: previously relied solely on scopedSession auto-injection)", async () => {
    await createAliasEdge(
      "alias-id",
      "principal-id",
      {
        confidence: 0.5,
        matchReason: "x",
        tentative: true,
      },
      "org-99",
    );
    const [, params] = mocks.sessionRun.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(params["orgId"]).toBe("org-99");
  });
});

describe("upsertSourceConnectionMeta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scopedSession.mockReturnValue({
      run: mocks.sessionRun,
      close: mocks.sessionClose,
    });
    mocks.sessionRun.mockResolvedValue({ records: [] });
  });

  it("runs a MERGE keyed on connectionId + orgId", async () => {
    await upsertSourceConnectionMeta(
      {
        connectionId: "conn-1",
        workspaceId: "ws-1",
        connectorType: "github",
        cursor: "cursor-1",
        lastSyncAt: "2026-01-01T00:00:00.000Z",
      },
      "org-1",
    );
    expect(mocks.sessionRun).toHaveBeenCalledOnce();
    const [cypher, params] = mocks.sessionRun.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(cypher).toContain(
      "MERGE (sc:SourceConnection {id: $connectionId, orgId: $orgId})",
    );
    expect(params["connectionId"]).toBe("conn-1");
    expect(params["workspaceId"]).toBe("ws-1");
  });

  // OXA-2062: the MERGE key is `{id: $connectionId, orgId: $orgId}` but the
  // local params object previously omitted `orgId` entirely, relying solely
  // on scopedSession()'s auto-injection.
  it("binds orgId explicitly in the MERGE params (regression: previously relied solely on scopedSession auto-injection)", async () => {
    await upsertSourceConnectionMeta(
      {
        connectionId: "conn-2",
        workspaceId: "ws-1",
        connectorType: "github",
        cursor: null,
        lastSyncAt: "2026-01-01T00:00:00.000Z",
      },
      "org-88",
    );
    const [, params] = mocks.sessionRun.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(params["orgId"]).toBe("org-88");
  });

  it("closes session on success", async () => {
    await upsertSourceConnectionMeta(
      {
        connectionId: "conn-3",
        workspaceId: "ws-1",
        connectorType: "github",
        cursor: null,
        lastSyncAt: "2026-01-01T00:00:00.000Z",
      },
      "org-1",
    );
    expect(mocks.sessionClose).toHaveBeenCalledOnce();
  });
});
