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

vi.mock("./event-client", () => ({
  eventClient: { send: mocks.inngestSend },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

import { connectionMappingsSetHandler } from "./connection.mappings.set";

// ── helper: build a mock transaction that returns fixed rows ──────────────────

/**
 * Creates a tx mock whose select chain resolves to `rows`.
 *
 * The connection lookup terminates at `.limit()`; the batched mapping lookup
 * terminates at `.where()`. Both terminal links resolve to `rows`, and `.where()`
 * also returns the chain so the connection lookup's `.where().limit()` still
 * works. Insert and update stubs resolve to an empty result.
 */
function makeTxReturning(rows: unknown[]) {
  const whereResult = Object.assign(Promise.resolve(rows), {
    limit: vi.fn().mockResolvedValue(rows),
  });
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnValue(whereResult),
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
 * Call 1: connection lookup → connRow (terminates at .limit()).
 * Call 2: the upsert+activate transaction. Its batched mapping lookup
 *         (terminates at .where()) resolves to existingRow; inserts/updates
 *         within the same tx resolve to empty.
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
    // Any further calls (defensive): return empty.
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
    setupDbSequence([{ ...GITHUB_CONN_ROW, status: "connected" }], []);

    const result = await connectionMappingsSetHandler(
      { ...ONE_MAPPING_INPUT, activateConnection: false },
      CTX,
    );
    expect(result.mappingsCreated).toBe(1);
    expect(result.mappingsUpdated).toBe(0);
  });

  it("does not fire inngest when already active connector", async () => {
    setupDbSequence([{ ...GITHUB_CONN_ROW, status: "connected" }], []);

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
    setupDbSequence(
      [{ ...GITHUB_CONN_ROW, status: "connected" }],
      [{ id: "etm-uuid-1", sourceRecordType: "pull_request" }],
    );

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
    expect(result.connectionStatus).toBe("connected");
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
    setupDbSequence([{ ...GITHUB_CONN_ROW, status: "connected" }], []);

    const result = await connectionMappingsSetHandler(ONE_MAPPING_INPUT, CTX);
    expect(result.connectionStatus).toBe("connected");
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

  it("uses request-supplied owner/repo when deliveryConfig is null (OXA-1806 root cause)", async () => {
    // This is the exact failure mode from OXA-1806: the stored deliveryConfig
    // is null (wizard never persisted owner/repo before this fix). The handler
    // must use the values from the request input, not empty strings from the DB.
    setupDbSequence([{ ...GITHUB_CONN_ROW, deliveryConfig: null }], []);

    await connectionMappingsSetHandler(
      {
        ...ONE_MAPPING_INPUT,
        owner: "acme",
        repo: "api",
        defaultBranch: "develop",
      },
      CTX,
    );

    const sent = mocks.inngestSend.mock.calls[0]?.[0] as { data: { owner: string; repo: string; defaultBranch: string } };
    expect(sent.data.owner).toBe("acme");
    expect(sent.data.repo).toBe("api");
    expect(sent.data.defaultBranch).toBe("develop");
  });

  it("merges request-supplied delivery config fields into the stored deliveryConfig (OXA-1806)", async () => {
    // The wizard now sends owner/repo/defaultBranch/installationId/syncDepthDays
    // in the PUT body. The handler should merge them into deliveryConfig in the
    // same tx as the activation, then build the event from the merged config.
    const existingDc = { someOtherKey: "value" };
    setupDbSequence([{ ...GITHUB_CONN_ROW, deliveryConfig: existingDc }], []);

    await connectionMappingsSetHandler(
      {
        ...ONE_MAPPING_INPUT,
        owner: "myorg",
        repo: "myrepo",
        defaultBranch: "main",
        installationId: "inst-42",
        syncDepthDays: 60,
      },
      CTX,
    );

    // Verify the event was fired with the request-provided values
    expect(mocks.inngestSend).toHaveBeenCalledOnce();
    const sent = mocks.inngestSend.mock.calls[0]?.[0] as {
      data: { owner: string; repo: string; defaultBranch: string };
    };
    expect(sent.data.owner).toBe("myorg");
    expect(sent.data.repo).toBe("myrepo");
    expect(sent.data.defaultBranch).toBe("main");
  });

  it("does NOT fire event for non-GitHub connectors", async () => {
    setupDbSequence([{ ...GITHUB_CONN_ROW, connectorId: "linear" }], []);

    await connectionMappingsSetHandler(ONE_MAPPING_INPUT, CTX);
    expect(mocks.inngestSend).not.toHaveBeenCalled();
  });
});
