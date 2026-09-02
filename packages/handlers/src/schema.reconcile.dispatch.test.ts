import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  versionFindFirst: vi.fn(),
  execInsertReturning: vi.fn(),
  execInsertValues: vi.fn(),
  inngestSend: vi.fn(),
}));

// Canonical agent_executions.origin_type set — mirror of AGENT_EXECUTION_ORIGIN_TYPES
// / the agent_executions_origin_type_check CHECK constraint. Inlined here (not
// imported) so the test fails loudly if the handler ever writes a value the DB
// would reject at INSERT.
const CANONICAL_ORIGIN_TYPES = [
  "chat",
  "event_trigger",
  "scheduled_job",
  "mcp_request",
  "workflow_run",
  "fanout",
];

// withTenantDb is called twice:
//   call 1 → query.schemaVersions.findFirst (resolve version by publicId)
//   call 2 → insert into agentExecutions (create execution row)
let withTenantDbCallCount = 0;

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      withTenantDbCallCount++;
      const call = withTenantDbCallCount;
      if (call === 1) {
        return fn({
          query: {
            schemaVersions: { findFirst: mocks.versionFindFirst },
          },
        });
      }
      // call 2 → insert path. Capture the inserted values so tests can assert
      // the row shape (esp. a canonical origin_type — see regression test below).
      return fn({
        insert: (_table: unknown) => ({
          values: (vals: unknown) => {
            mocks.execInsertValues(vals);
            return { returning: mocks.execInsertReturning };
          },
        }),
      });
    },
  };
});

vi.mock("./event-client", () => ({
  eventClient: { send: mocks.inngestSend },
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { schemaReconcileDispatchHandler } from "./schema.reconcile.dispatch";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ─────────────────────────────────────────────────────────────────────────────

const MOCK_VERSION = {
  id: "ver-internal-uuid-1",
  publicId: "scv_abc",
  versionNumber: 3,
};

const MOCK_EXEC = {
  id: "exec-internal-uuid-1",
  publicId: "aex_xyz",
};

const BASE_INPUT = {
  versionId: "scv_abc",
  prune: false,
};

function setupHappyPath() {
  mocks.versionFindFirst.mockResolvedValue(MOCK_VERSION);
  mocks.execInsertReturning.mockResolvedValue([MOCK_EXEC]);
  mocks.inngestSend.mockResolvedValue(undefined);
}

describe("schemaReconcileDispatchHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withTenantDbCallCount = 0;
    setupHappyPath();
  });

  it("returns executionId (public_id) on success", async () => {
    const result = await schemaReconcileDispatchHandler(BASE_INPUT, CTX);
    expect(result.executionId).toBe("aex_xyz");
  });

  it("writes agent_executions row and sends inngest event", async () => {
    const result = await schemaReconcileDispatchHandler(BASE_INPUT, CTX);

    // Inngest event fired once with correct shape
    expect(mocks.inngestSend).toHaveBeenCalledTimes(1);
    expect(mocks.inngestSend).toHaveBeenCalledWith({
      name: "schema/reconcile.start",
      data: {
        orgId: CTX.orgId,
        workspaceId: CTX.workspaceId,
        executionId: MOCK_EXEC.id,
        versionId: BASE_INPUT.versionId,
        prune: false,
      },
    });

    // Insert was called
    expect(mocks.execInsertReturning).toHaveBeenCalledTimes(1);
    expect(result.executionId).toBe("aex_xyz");
  });

  it("throws if version not found", async () => {
    mocks.versionFindFirst.mockResolvedValueOnce(undefined);
    await expect(
      schemaReconcileDispatchHandler(BASE_INPUT, CTX),
    ).rejects.toThrow(
      "schema.reconcile.dispatch: schema version not found: scv_abc",
    );
    // Inngest event must NOT be sent
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("throws if agent_executions insert returns no row", async () => {
    mocks.execInsertReturning.mockResolvedValueOnce([]);
    await expect(
      schemaReconcileDispatchHandler(BASE_INPUT, CTX),
    ).rejects.toThrow(
      "schema.reconcile.dispatch: agent_executions insert returned no row",
    );
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("passes prune=true into the inngest event payload", async () => {
    await schemaReconcileDispatchHandler({ ...BASE_INPUT, prune: true }, CTX);
    expect(mocks.inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ prune: true }),
      }),
    );
  });

  it("resolves the schema version before inserting the execution row", async () => {
    await schemaReconcileDispatchHandler(BASE_INPUT, CTX);
    expect(mocks.versionFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.execInsertReturning).toHaveBeenCalledTimes(1);
  });

  // Regression (prod login hotfix): the handler previously inserted
  // origin_type='schema.reconcile.dispatch', a value outside the
  // agent_executions_origin_type_check CHECK. Those rows blocked the prod
  // migration chain (the CHECK add failed "violated by some row"), which
  // cascaded into Better Auth's two_factor migration never applying and took
  // production login down. origin_type MUST be a canonical value.
  it("inserts a CHECK-valid canonical origin_type", async () => {
    await schemaReconcileDispatchHandler(BASE_INPUT, CTX);
    expect(mocks.execInsertValues).toHaveBeenCalledTimes(1);
    const inserted = mocks.execInsertValues.mock.calls[0]?.[0] as {
      originType?: string;
    };
    expect(inserted?.originType).toBe("event_trigger");
    expect(CANONICAL_ORIGIN_TYPES).toContain(inserted?.originType);
  });
});
