import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
  sessionRun: vi.fn(),
  sessionClose: vi.fn(),
  scopedSession: vi.fn(),
  generateObjectFor: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../create-function", () => ({
  createFunction: mocks.createFunction,
}));

vi.mock("@oxagen/database", () => ({
  withTenantDb: mocks.withTenantDb,
  // schema is aliased as "db" in the source; exported as "schema"
  schema: {
    agentExecutions: { id: "id", orgId: "org_id" },
    schemaVersions: {
      publicId: "public_id",
      orgId: "org_id",
      workspaceId: "workspace_id",
    },
    schemas: {
      versionId: "version_id",
      orgId: "org_id",
      workspaceId: "workspace_id",
      deletedAt: "deleted_at",
    },
    schemaActivations: {
      orgId: "org_id",
      workspaceId: "workspace_id",
      deletedAt: "deleted_at",
      schemaName: "schema_name",
    },
    nodeLabels: {
      versionId: "version_id",
      schemaId: "schema_id",
      orgId: "org_id",
      deletedAt: "deleted_at",
    },
    relationshipTypes: {
      versionId: "version_id",
      schemaId: "schema_id",
      orgId: "org_id",
      deletedAt: "deleted_at",
    },
    schemaProperties: {
      versionId: "version_id",
      orgId: "org_id",
      deletedAt: "deleted_at",
    },
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: vi.fn((...args: unknown[]) => args),
    and: vi.fn((...args: unknown[]) => args),
    isNull: vi.fn((arg: unknown) => arg),
    inArray: vi.fn((...args: unknown[]) => args),
  };
});

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope,
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: mocks.scopedSession,
}));

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectFor,
}));

vi.mock("../logger", () => ({
  logger: mocks.logger,
}));

// ── Capture handler ───────────────────────────────────────────────────────────
type StepCtx = {
  run: (name: string, fn: () => Promise<unknown>) => Promise<unknown>;
};

type HandlerFn = (ctx: {
  event: { data: unknown };
  step: StepCtx;
}) => Promise<unknown>;

let capturedHandler: HandlerFn | null = null;

mocks.createFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: HandlerFn) => {
    capturedHandler = handler;
    return [{}];
  },
);

await import("./schema.reconcile");

function makeStep(): StepCtx {
  return {
    run: async (_name: string, fn: () => Promise<unknown>) => fn(),
  };
}

const BASE_EVENT_DATA = {
  orgId: "org-1",
  workspaceId: "ws-1",
  executionId: "exec-1",
  versionId: "ver-pub-1",
  prune: false,
};

// ── Fake tx builder ───────────────────────────────────────────────────────────
interface TxMocks {
  schemaVersionsFindFirst: ReturnType<typeof vi.fn>;
  schemasFindMany: ReturnType<typeof vi.fn>;
  schemaActivationsFindMany: ReturnType<typeof vi.fn>;
  nodeLabelsFindMany: ReturnType<typeof vi.fn>;
  relTypesFindMany: ReturnType<typeof vi.fn>;
  propertiesFindMany: ReturnType<typeof vi.fn>;
  agentExecsFindFirst: ReturnType<typeof vi.fn>;
}

function makeTx(): { tx: unknown; m: TxMocks } {
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = { set: vi.fn().mockReturnValue({ where: updateWhere }) };
  const updateFn = vi.fn().mockReturnValue(updateSet);

  const schemaVersionsFindFirst = vi.fn().mockResolvedValue(undefined);
  const schemasFindMany = vi.fn().mockResolvedValue([]);
  const schemaActivationsFindMany = vi.fn().mockResolvedValue([]);
  const nodeLabelsFindMany = vi.fn().mockResolvedValue([]);
  const relTypesFindMany = vi.fn().mockResolvedValue([]);
  const propertiesFindMany = vi.fn().mockResolvedValue([]);
  const agentExecsFindFirst = vi
    .fn()
    .mockResolvedValue({ startedAt: new Date() });

  const tx = {
    update: updateFn,
    query: {
      schemaVersions: { findFirst: schemaVersionsFindFirst },
      schemas: { findMany: schemasFindMany },
      schemaActivations: { findMany: schemaActivationsFindMany },
      nodeLabels: { findMany: nodeLabelsFindMany },
      relationshipTypes: { findMany: relTypesFindMany },
      schemaProperties: { findMany: propertiesFindMany },
      agentExecutions: { findFirst: agentExecsFindFirst },
    },
  };

  return {
    tx,
    m: {
      schemaVersionsFindFirst,
      schemasFindMany,
      schemaActivationsFindMany,
      nodeLabelsFindMany,
      relTypesFindMany,
      propertiesFindMany,
      agentExecsFindFirst,
    },
  };
}

// Build a Neo4j record-like object for session.run return values
function makeNodeRecord(nodeId: string, label: string, propertiesJson: string) {
  return {
    get: (key: string): unknown => {
      const map: Record<string, unknown> = {
        nodeId,
        label,
        properties: propertiesJson,
        displayName: nodeId,
      };
      return map[key];
    },
  };
}

function makeCountRecord(count: number) {
  return {
    get: (_key: string): unknown => count,
  };
}

// Build a session mock that uses a call-counter to return values in sequence.
// This is more reliable than mockResolvedValueOnce since vi.clearAllMocks()
// clears the once-queue in vitest 2.x.
function makeSessionRunSequence(
  responses: Array<{ records: Array<{ get: (k: string) => unknown }> }>,
): () => Promise<{ records: Array<{ get: (k: string) => unknown }> }> {
  let idx = 0;
  return async () => {
    const r = responses[idx];
    idx++;
    return r ?? { records: [] };
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("schemaReconcile Inngest handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runInTenantScope.mockImplementation(
      (_scope: unknown, fn: () => unknown) => fn(),
    );
    mocks.sessionClose.mockResolvedValue(undefined);
    mocks.scopedSession.mockImplementation(() => ({
      run: mocks.sessionRun,
      close: mocks.sessionClose,
    }));
    // Default: session.run returns empty records
    mocks.sessionRun.mockResolvedValue({ records: [] });
  });

  it("throws 'schema version not found' when the version row is missing", async () => {
    const { tx } = makeTx();
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );

    await expect(
      capturedHandler!({ event: { data: BASE_EVENT_DATA }, step: makeStep() }),
    ).rejects.toThrow("schema version not found");
  });

  it("exits early with status:completed, totalNodes:0 when no schemas exist for the version", async () => {
    const { tx, m } = makeTx();
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );
    m.schemaVersionsFindFirst.mockResolvedValue({
      id: "ver-1",
      versionNumber: 1,
    });
    m.schemasFindMany.mockResolvedValue([]); // no schemas

    const result = await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    expect(result).toEqual({
      executionId: "exec-1",
      status: "completed",
      totalNodes: 0,
      totalRelationships: 0,
    });
  });

  it("exits early with status:completed when all schemas are disabled", async () => {
    const { tx, m } = makeTx();
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );
    m.schemaVersionsFindFirst.mockResolvedValue({
      id: "ver-1",
      versionNumber: 1,
    });
    m.schemasFindMany.mockResolvedValue([{ id: "s-1", name: "mySchema" }]);
    m.schemaActivationsFindMany.mockResolvedValue([
      { schemaName: "mySchema", enabled: false },
    ]);

    const result = await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    expect(result).toEqual({
      executionId: "exec-1",
      status: "completed",
      totalNodes: 0,
      totalRelationships: 0,
    });
  });

  it("happy path: 1 label, 1 node with no missing props → processedNodes:1, updatedNodes:0", async () => {
    const { tx, m } = makeTx();
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );

    m.schemaVersionsFindFirst.mockResolvedValue({
      id: "ver-1",
      versionNumber: 1,
    });
    m.schemasFindMany.mockResolvedValue([{ id: "s-1", name: "mySchema" }]);
    m.schemaActivationsFindMany.mockResolvedValue([]); // empty → enabled by default
    m.nodeLabelsFindMany.mockResolvedValue([{ id: "l-1", name: "MyLabel" }]);
    m.relTypesFindMany.mockResolvedValue([]);
    m.propertiesFindMany.mockResolvedValue([
      {
        id: "p-1",
        nodeLabelId: "l-1",
        relationshipTypeId: null,
        key: "name",
        dataType: "string",
        required: false,
        description: null,
      },
    ]);

    // count(1), batch with 1 node, batch end
    const nodeRecord = makeNodeRecord("node-1", "MyLabel", "{}");
    mocks.sessionRun.mockImplementation(
      makeSessionRunSequence([
        { records: [makeCountRecord(1)] }, // count nodes
        { records: [nodeRecord] }, // batch 1
        { records: [] }, // batch 2 end
      ]),
    );

    const result = await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    const r = result as Record<string, unknown>;
    expect(r.status).toBe("completed");
    expect(r.processedNodes).toBe(1);
    expect(r.updatedNodes).toBe(0); // no required props missing, no prune
    expect(r.totalNodes).toBe(1);
    expect(r.totalRelationships).toBe(0);
    expect(r.prunedNodes).toBe(0);
  });

  it("prune=true: node with off-schema property → updatedNodes:1, prunedNodes:1", async () => {
    const { tx, m } = makeTx();
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );

    m.schemaVersionsFindFirst.mockResolvedValue({
      id: "ver-1",
      versionNumber: 1,
    });
    m.schemasFindMany.mockResolvedValue([{ id: "s-1", name: "mySchema" }]);
    m.schemaActivationsFindMany.mockResolvedValue([]);
    m.nodeLabelsFindMany.mockResolvedValue([{ id: "l-1", name: "MyLabel" }]);
    m.relTypesFindMany.mockResolvedValue([]);
    // Schema only has "name", not "extra"
    m.propertiesFindMany.mockResolvedValue([
      {
        id: "p-1",
        nodeLabelId: "l-1",
        relationshipTypeId: null,
        key: "name",
        dataType: "string",
        required: false,
        description: null,
      },
    ]);

    // Node has an extra off-schema property
    const nodeProps = JSON.stringify({
      name: "Acme",
      extra: "should be pruned",
    });
    const nodeRecord = makeNodeRecord("node-1", "MyLabel", nodeProps);

    // count(1), batch 1 node, SET update (returns []), batch end ([])
    mocks.sessionRun.mockImplementation(
      makeSessionRunSequence([
        { records: [makeCountRecord(1)] }, // count nodes
        { records: [nodeRecord] }, // batch 1
        { records: [] }, // SET n.properties (prune update)
        { records: [] }, // batch 2 end
      ]),
    );

    const result = await capturedHandler!({
      event: { data: { ...BASE_EVENT_DATA, prune: true } },
      step: makeStep(),
    });

    const r = result as Record<string, unknown>;
    expect(r.updatedNodes).toBe(1);
    expect(r.prunedNodes).toBe(1);
  });

  it("AI derivation is called for missing required props and updates the node", async () => {
    const { tx, m } = makeTx();
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );

    m.schemaVersionsFindFirst.mockResolvedValue({
      id: "ver-1",
      versionNumber: 1,
    });
    m.schemasFindMany.mockResolvedValue([{ id: "s-1", name: "mySchema" }]);
    m.schemaActivationsFindMany.mockResolvedValue([]);
    m.nodeLabelsFindMany.mockResolvedValue([{ id: "l-1", name: "MyLabel" }]);
    m.relTypesFindMany.mockResolvedValue([]);
    // Required property missing from node
    m.propertiesFindMany.mockResolvedValue([
      {
        id: "p-1",
        nodeLabelId: "l-1",
        relationshipTypeId: null,
        key: "summary",
        dataType: "string",
        required: true,
        description: "A brief summary",
      },
    ]);

    mocks.generateObjectFor.mockResolvedValue({
      object: { derivedProps: { summary: "AI-generated summary" } },
    });

    const nodeRecord = makeNodeRecord("node-1", "MyLabel", "{}"); // no summary
    mocks.sessionRun.mockImplementation(
      makeSessionRunSequence([
        { records: [makeCountRecord(1)] }, // count
        { records: [nodeRecord] }, // batch 1
        { records: [] }, // SET (AI-derived props written)
        { records: [] }, // batch 2 end
      ]),
    );

    const result = await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    expect(mocks.generateObjectFor).toHaveBeenCalledOnce();
    const r = result as Record<string, unknown>;
    expect(r.updatedNodes).toBe(1);
  });

  it("logs a warning and skips AI derivation when generateObjectFor throws", async () => {
    const { tx, m } = makeTx();
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );

    m.schemaVersionsFindFirst.mockResolvedValue({
      id: "ver-1",
      versionNumber: 1,
    });
    m.schemasFindMany.mockResolvedValue([{ id: "s-1", name: "mySchema" }]);
    m.schemaActivationsFindMany.mockResolvedValue([]);
    m.nodeLabelsFindMany.mockResolvedValue([{ id: "l-1", name: "MyLabel" }]);
    m.relTypesFindMany.mockResolvedValue([]);
    m.propertiesFindMany.mockResolvedValue([
      {
        id: "p-1",
        nodeLabelId: "l-1",
        relationshipTypeId: null,
        key: "summary",
        dataType: "string",
        required: true,
        description: "A brief summary",
      },
    ]);

    mocks.generateObjectFor.mockRejectedValue(new Error("AI gateway timeout"));

    const nodeRecord = makeNodeRecord("node-1", "MyLabel", "{}");
    mocks.sessionRun.mockImplementation(
      makeSessionRunSequence([
        { records: [makeCountRecord(1)] }, // count
        { records: [nodeRecord] }, // batch 1
        { records: [] }, // batch 2 end (no SET since AI skipped)
      ]),
    );

    const result = await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    // AI step skipped, node NOT updated
    const r = result as Record<string, unknown>;
    expect(r.updatedNodes).toBe(0);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "node-1" }),
      expect.stringContaining("AI derivation failed"),
    );
  });

  it("relationship reconcile with prune=true removes off-schema relationship props", async () => {
    const { tx, m } = makeTx();
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );

    m.schemaVersionsFindFirst.mockResolvedValue({
      id: "ver-1",
      versionNumber: 1,
    });
    m.schemasFindMany.mockResolvedValue([{ id: "s-1", name: "mySchema" }]);
    m.schemaActivationsFindMany.mockResolvedValue([]);
    m.nodeLabelsFindMany.mockResolvedValue([]); // no node labels
    m.relTypesFindMany.mockResolvedValue([{ id: "rt-1", name: "RELATES_TO" }]);
    // Schema defines only "weight" for this rel type
    m.propertiesFindMany.mockResolvedValue([
      {
        id: "p-1",
        nodeLabelId: null,
        relationshipTypeId: "rt-1",
        key: "weight",
        dataType: "number",
        required: false,
        description: null,
      },
    ]);

    const relRecord = {
      get: (key: string): unknown => {
        const map: Record<string, unknown> = {
          relElemId: "elem-1",
          relType: "RELATES_TO",
          props: { weight: 0.9, extra: "off-schema" }, // extra should be pruned
        };
        return map[key];
      },
    };

    // count rels(1), batch 1 rel, SET r += (prune), batch 2 end
    mocks.sessionRun.mockImplementation(
      makeSessionRunSequence([
        { records: [makeCountRecord(1)] }, // count rels (no labels → no node count)
        { records: [relRecord] }, // batch 1
        { records: [] }, // SET r +=
        { records: [] }, // batch 2 end
      ]),
    );

    const result = await capturedHandler!({
      event: { data: { ...BASE_EVENT_DATA, prune: true } },
      step: makeStep(),
    });

    const r = result as Record<string, unknown>;
    expect(r.prunedRelationships).toBe(1);
    expect(r.updatedRelationships).toBe(1);
  });

  it("returns 0 processedNodes when labelNames is empty (no node reconcile)", async () => {
    const { tx, m } = makeTx();
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(tx),
    );

    m.schemaVersionsFindFirst.mockResolvedValue({
      id: "ver-1",
      versionNumber: 1,
    });
    m.schemasFindMany.mockResolvedValue([{ id: "s-1", name: "mySchema" }]);
    m.schemaActivationsFindMany.mockResolvedValue([]);
    m.nodeLabelsFindMany.mockResolvedValue([]);
    m.relTypesFindMany.mockResolvedValue([]);
    m.propertiesFindMany.mockResolvedValue([]);

    const result = await capturedHandler!({
      event: { data: BASE_EVENT_DATA },
      step: makeStep(),
    });

    const r = result as Record<string, unknown>;
    expect(r.totalNodes).toBe(0);
    expect(r.totalRelationships).toBe(0);
    expect(r.status).toBe("completed");
  });
});
