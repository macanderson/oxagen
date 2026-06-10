/**
 * connection.mappings.set handler tests.
 *
 * Strategy: mock @oxagen/database (withTenantDb) and @oxagen/inngest-functions/client.
 * Assert:
 *   - connection not found → throws HTTPException 404
 *   - saves new mappings (created count)
 *   - updates existing mappings (updated count)
 *   - activates connection when activateConnection=true and status=pending_setup
 *   - does NOT activate when activateConnection=false
 *   - fires ingestion/github.initial-sync event when connectorId=github + activateConnection=true
 *   - does NOT fire event when connectorId is not github
 *   - does NOT fire event when connection is already active
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ── mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  inngestSend: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock("@oxagen/inngest-functions/client", () => ({
  inngest: { send: mocks.inngestSend },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

import { connectionMappingsSetHandler } from "./connection.mappings.set";

// ── helper: build a mock transaction that returns fixed rows ──────────────────

/**
 * Creates a tx mock whose select chain always resolves .limit() to `rows`.
 * Also provides insert and update stubs.
 */
function makeTxReturning(rows: unknown[]) {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return {
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue([{}]),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{}]),
    }),
  };
}

type TxLike = ReturnType<typeof makeTxReturning>;
type DbFn = (tx: TxLike) => Promise<unknown>;

// ── valid input helpers ───────────────────────────────────────────────────────

const ONE_MAPPING_INPUT = {
  connectionId: "con_ABC",
  mappings: [{ sourceRecordType: "pull_request", oxagenEntityType: "code_change", propertyMappings: {} }],
  activateConnection: true,
};

const GITHUB_CONN_ROW = {
  id: "uuid-conn-1",
  status: "pending_setup",
  connectorId: "github",
  deliveryConfig: { owner: "acme", repo: "my-api", defaultBranch: "main" },
};

/**
 * Set up withTenantDb to return specific rows per sequential call.
 * Call 1: connection lookup → connRow
 * Call 2: existing mapping lookup → existingRow
 * Call 3+: write operations → empty
 */
function setupDbSequence(
  connRow: unknown[],
  existingRow: unknown[],
) {
  let callIdx = 0;
  mocks.withTenantDb.mockImplementation((fn: DbFn) => {
    callIdx++;
    if (callIdx === 1) return fn(makeTxReturning(connRow) as TxLike);
    if (callIdx === 2) return fn(makeTxReturning(existingRow) as TxLike);
    // Subsequent calls: insert/update/activate — return empty
    return fn(makeTxReturning([]) as TxLike);
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inngestSend.mockResolvedValue({});
});

// ── not found ─────────────────────────────────────────────────────────────────

describe("connectionMappingsSetHandler — not found", () => {
  it("throws 404 HTTPException when connection is not found", async () => {
    mocks.withTenantDb.mockImplementation((fn: DbFn) =>
      fn(makeTxReturning([]) as TxLike),
    );
    await expect(connectionMappingsSetHandler(ONE_MAPPING_INPUT, CTX)).rejects.toMatchObject({
      status: 404,
    });
  });
});

// ── new mapping ───────────────────────────────────────────────────────────────

describe("connectionMappingsSetHandler — new mapping (insert)", () => {
  it("inserts a new mapping when none exists and returns mappingsCreated=1", async () => {
    // connection found, no existing mapping → insert path
    setupDbSequence([{ ...GITHUB_CONN_ROW, status: "active" }], []);

    const result = await connectionMappingsSetHandler(
      { ...ONE_MAPPING_INPUT, activateConnection: false },
      CTX,
    );
    expect(result.mappingsCreated).toBe(1);
    expect(result.mappingsUpdated).toBe(0);
  });

  it("does not fire inngest when already active connector", async () => {
    setupDbSequence([{ ...GITHUB_CONN_ROW, status: "active" }], []);

    await connectionMappingsSetHandler(
      { ...ONE_MAPPING_INPUT, activateConnection: true }, // activateConnection=true but already active
      CTX,
    );
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });
});

// ── update existing mapping ────────────────────────────────────────────────────

describe("connectionMappingsSetHandler — update existing mapping", () => {
  it("updates an existing mapping and returns mappingsUpdated=1", async () => {
    // connection found (active), existing mapping found → update path
    setupDbSequence([{ ...GITHUB_CONN_ROW, status: "active" }], [{ id: "etm-uuid-1" }]);

    const result = await connectionMappingsSetHandler(
      { ...ONE_MAPPING_INPUT, activateConnection: false },
      CTX,
    );
    expect(result.mappingsCreated).toBe(0);
    expect(result.mappingsUpdated).toBe(1);
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });
});

// ── activation ────────────────────────────────────────────────────────────────

describe("connectionMappingsSetHandler — connection activation", () => {
  it("activates connection when status=pending_setup and activateConnection=true", async () => {
    setupDbSequence([GITHUB_CONN_ROW], []);

    const result = await connectionMappingsSetHandler(ONE_MAPPING_INPUT, CTX);
    expect(result.connectionStatus).toBe("active");
  });

  it("leaves status unchanged when activateConnection=false", async () => {
    setupDbSequence([GITHUB_CONN_ROW], []);

    const result = await connectionMappingsSetHandler(
      { ...ONE_MAPPING_INPUT, activateConnection: false },
      CTX,
    );
    expect(result.connectionStatus).toBe("pending_setup");
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });

  it("leaves status unchanged when already active", async () => {
    setupDbSequence([{ ...GITHUB_CONN_ROW, status: "active" }], []);

    const result = await connectionMappingsSetHandler(ONE_MAPPING_INPUT, CTX);
    expect(result.connectionStatus).toBe("active");
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });
});

// ── GitHub initial-sync event ─────────────────────────────────────────────────

describe("connectionMappingsSetHandler — GitHub initial-sync event", () => {
  it("fires ingestion/github.initial-sync when github connector is activated from pending_setup", async () => {
    setupDbSequence([GITHUB_CONN_ROW], []);

    await connectionMappingsSetHandler(ONE_MAPPING_INPUT, CTX);

    expect(mocks.inngestSend).toHaveBeenCalledOnce();
    const sent = mocks.inngestSend.mock.calls[0]?.[0] as {
      name: string;
      data: {
        connectionId: string;
        orgId: string;
        workspaceId: string;
        owner: string;
        repo: string;
        defaultBranch: string;
      };
    };
    expect(sent.name).toBe("ingestion/github.initial-sync");
    expect(sent.data.connectionId).toBe(GITHUB_CONN_ROW.id);
    expect(sent.data.orgId).toBe(CTX.orgId);
    expect(sent.data.workspaceId).toBe(CTX.workspaceId);
    expect(sent.data.owner).toBe("acme");
    expect(sent.data.repo).toBe("my-api");
    expect(sent.data.defaultBranch).toBe("main");
  });

  it("defaults to 'main' branch when deliveryConfig has no defaultBranch", async () => {
    setupDbSequence(
      [{ ...GITHUB_CONN_ROW, deliveryConfig: { owner: "acme", repo: "my-api" } }],
      [],
    );

    await connectionMappingsSetHandler(ONE_MAPPING_INPUT, CTX);

    const sent = mocks.inngestSend.mock.calls[0]?.[0] as { data: { defaultBranch: string } };
    expect(sent.data.defaultBranch).toBe("main");
  });

  it("sends empty owner/repo when deliveryConfig is null", async () => {
    setupDbSequence([{ ...GITHUB_CONN_ROW, deliveryConfig: null }], []);

    await connectionMappingsSetHandler(ONE_MAPPING_INPUT, CTX);

    const sent = mocks.inngestSend.mock.calls[0]?.[0] as { data: { owner: string; repo: string } };
    expect(sent.data.owner).toBe("");
    expect(sent.data.repo).toBe("");
  });

  it("does NOT fire event for non-GitHub connectors", async () => {
    setupDbSequence([{ ...GITHUB_CONN_ROW, connectorId: "linear" }], []);

    await connectionMappingsSetHandler(ONE_MAPPING_INPUT, CTX);
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });
});
