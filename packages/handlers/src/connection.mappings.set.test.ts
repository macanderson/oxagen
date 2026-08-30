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

// The installation-access authorization gate makes its own oauth_accounts lookup
// + GitHub /user/installations call and has a dedicated suite
// (__tests__/github-installation-access.test.ts). These tests exercise the
// deliveryConfig-merge + activation logic, so stub the gate to a no-op — otherwise
// it fires on the github + installationId cases and throws 403 (no mocked token).
vi.mock("./lib/github-installation-access", () => ({
  assertGithubInstallationAccessible: vi.fn(),
}));

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
  mappings: [
    {
      sourceRecordType: "pull_request",
      oxagenEntityType: "code_change",
      propertyMappings: {},
    },
  ],
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
function setupDbSequence(connRow: unknown[], existingRow: unknown[]) {
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
    await expect(
      connectionMappingsSetHandler(ONE_MAPPING_INPUT, CTX),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

// ── new mapping ───────────────────────────────────────────────────────────────

describe("connectionMappingsSetHandler — new mapping (insert)", () => {
  it("inserts a new mapping when none exists and returns mappingsCreated=1", async () => {
    // Non-GitHub connector → no default-mapping seeding, so the raw insert count
    // is exactly the one supplied mapping.
    setupDbSequence(
      [{ ...GITHUB_CONN_ROW, connectorId: "linear", status: "connected" }],
      [],
    );

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
    // Non-GitHub connector (no seeding) so the supplied pull_request mapping is
    // the only one written; it already exists → pure update path.
    setupDbSequence(
      [{ ...GITHUB_CONN_ROW, connectorId: "linear", status: "connected" }],
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
  it("fires ingestion/github.initial-sync (owner/repo from deliveryConfig) when activated", async () => {
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
        syncDepthDays: number;
      };
    };
    expect(sent.name).toBe("ingestion/github.initial-sync");
    expect(sent.data.connectionId).toBe(GITHUB_CONN_ROW.id);
    expect(sent.data.orgId).toBe(CTX.orgId);
    expect(sent.data.workspaceId).toBe(CTX.workspaceId);
    expect(sent.data.owner).toBe("acme");
    expect(sent.data.repo).toBe("my-api");
    // defaultBranch is passed as a hint (from deliveryConfig); the sync still
    // resolves the repo's real default branch from the GitHub API.
    expect(sent.data.defaultBranch).toBe("main");
    expect(sent.data.syncDepthDays).toBe(90); // default when unspecified
  });

  it("fires one sync per selectedRepo and persists them to deliveryConfig", async () => {
    setupDbSequence([{ ...GITHUB_CONN_ROW, deliveryConfig: null }], []);

    await connectionMappingsSetHandler(
      {
        ...ONE_MAPPING_INPUT,
        selectedRepos: ["acme/api", "acme/web"],
        syncDepthDays: 30,
      },
      CTX,
    );

    expect(mocks.inngestSend).toHaveBeenCalledTimes(2);
    const calls = mocks.inngestSend.mock.calls.map(
      (c) =>
        c[0] as {
          data: { owner: string; repo: string; syncDepthDays: number };
        },
    );
    expect(calls.map((c) => `${c.data.owner}/${c.data.repo}`)).toEqual([
      "acme/api",
      "acme/web",
    ]);
    expect(calls[0]!.data.syncDepthDays).toBe(30);
  });

  it("seeds default mappings for every GitHub record type", async () => {
    // The wizard only confirms `repository`; the handler must also create
    // pull_request/issue/release/commit so the pipeline doesn't skip them.
    setupDbSequence([GITHUB_CONN_ROW], []);

    const result = await connectionMappingsSetHandler(
      {
        connectionId: "con_ABC",
        mappings: [
          {
            sourceRecordType: "repository",
            oxagenEntityType: "source_repository",
            propertyMappings: {},
          },
        ],
        activateConnection: true,
        selectedRepos: ["acme/my-api"],
      },
      CTX,
    );
    // repository (user) + pull_request + issue + release + commit (seeded) = 5.
    expect(result.mappingsCreated).toBe(5);
  });

  it("uses request-supplied owner/repo when deliveryConfig is null (OXA-1806 root cause)", async () => {
    // The stored deliveryConfig can be null if the wizard never persisted
    // owner/repo. The handler must use the values from the request input,
    // not empty strings from the DB.
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

    const sent = mocks.inngestSend.mock.calls[0]?.[0] as {
      data: { owner: string; repo: string; defaultBranch: string };
    };
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

// ── auto-name (connection displayName = repo slug) ────────────────────────────

describe("connectionMappingsSetHandler — auto-name to repo slug", () => {
  /**
   * Build a tx that captures every `update(...).set(payload)` call so a test can
   * assert what the activation UPDATE wrote (e.g. displayName). Mirrors
   * makeTxReturning's select/insert chain.
   */
  function makeTxCapturingSets(
    rows: unknown[],
    sets: Array<Record<string, unknown>>,
  ) {
    const whereResult = Object.assign(Promise.resolve(rows), {
      limit: vi.fn().mockResolvedValue(rows),
    });
    return {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnValue(whereResult),
      }),
      insert: vi
        .fn()
        .mockReturnValue({ values: vi.fn().mockResolvedValue([{}]) }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
          sets.push(payload);
          return { where: vi.fn().mockResolvedValue([{}]) };
        }),
      }),
    };
  }

  /** Return the payload of the UPDATE that flipped/kept status, i.e. carried displayName. */
  function setupCapture(connRow: unknown[]): Array<Record<string, unknown>> {
    const sets: Array<Record<string, unknown>> = [];
    let callIdx = 0;
    mocks.withTenantDb.mockImplementation((fn: DbFn) => {
      callIdx++;
      if (callIdx === 1) return fn(makeTxReturning(connRow) as TxLike);
      return fn(makeTxCapturingSets([], sets) as unknown as TxLike);
    });
    return sets;
  }

  it("names the connection after the single selected repo slug", async () => {
    const sets = setupCapture([{ ...GITHUB_CONN_ROW, deliveryConfig: null }]);

    await connectionMappingsSetHandler(
      { ...ONE_MAPPING_INPUT, selectedRepos: ["acme-org/backend-api"] },
      CTX,
    );

    const named = sets.find((s) => "displayName" in s);
    expect(named?.["displayName"]).toBe("acme-org/backend-api");
  });

  it("names the connection after owner/repo when supplied without selectedRepos", async () => {
    const sets = setupCapture([{ ...GITHUB_CONN_ROW, deliveryConfig: null }]);

    await connectionMappingsSetHandler(
      { ...ONE_MAPPING_INPUT, owner: "acme", repo: "widgets" },
      CTX,
    );

    const named = sets.find((s) => "displayName" in s);
    expect(named?.["displayName"]).toBe("acme/widgets");
  });

  it("shows the primary repo plus a (+N more) count for multi-repo selections", async () => {
    const sets = setupCapture([{ ...GITHUB_CONN_ROW, deliveryConfig: null }]);

    await connectionMappingsSetHandler(
      {
        ...ONE_MAPPING_INPUT,
        selectedRepos: ["acme/api", "acme/web", "acme/infra"],
      },
      CTX,
    );

    const named = sets.find((s) => "displayName" in s);
    expect(named?.["displayName"]).toBe("acme/api (+2 more)");
  });

  it("renames even when the connection is NOT being activated (config-only PUT)", async () => {
    const sets = setupCapture([
      { ...GITHUB_CONN_ROW, status: "connected", deliveryConfig: null },
    ]);

    await connectionMappingsSetHandler(
      {
        ...ONE_MAPPING_INPUT,
        activateConnection: false,
        selectedRepos: ["acme/renamed"],
      },
      CTX,
    );

    const named = sets.find((s) => "displayName" in s);
    expect(named?.["displayName"]).toBe("acme/renamed");
  });

  it("does NOT rename non-GitHub connectors", async () => {
    const sets = setupCapture([
      { ...GITHUB_CONN_ROW, connectorId: "linear", deliveryConfig: null },
    ]);

    await connectionMappingsSetHandler(
      { ...ONE_MAPPING_INPUT, selectedRepos: ["acme/api"] },
      CTX,
    );

    expect(sets.some((s) => "displayName" in s)).toBe(false);
  });

  it("does NOT blank the name when no repo is resolvable", async () => {
    const sets = setupCapture([{ ...GITHUB_CONN_ROW, deliveryConfig: null }]);

    // No selectedRepos, no owner/repo, and stored deliveryConfig is null → nothing to name to.
    await connectionMappingsSetHandler(
      {
        connectionId: "con_ABC",
        mappings: ONE_MAPPING_INPUT.mappings,
        activateConnection: true,
      },
      CTX,
    );

    expect(sets.some((s) => "displayName" in s)).toBe(false);
  });
});
