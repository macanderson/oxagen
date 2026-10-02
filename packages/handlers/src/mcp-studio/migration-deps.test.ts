// migration-deps.test.ts: the production dependencies of
// migrate_tools_to_steering (ADR-245, #4948). The database, the registered
// steering PR opener, the steering host, and migrate() are doubles. Each case
// checks what one dependency reads or writes.
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  steeringPrOpener: vi.fn(),
  listMovableLegacyServers: vi.fn(),
  migrate: vi.fn(),
  host: {
    resolveRepository: vi.fn(),
    getPullRequest: vi.fn(),
    listFiles: vi.fn(),
  },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The organisation seam gets the same mock, so neither runs unmocked (ADR-086).
  return { ...real, withTenantDb: mocks.withTenantDb, withOrgDb: mocks.withTenantDb };
});
vi.mock("@oxagen/agent/runtime/steering-pr", () => ({
  steeringPrOpener: mocks.steeringPrOpener,
  listMovableLegacyServers: mocks.listMovableLegacyServers,
}));
vi.mock("../context.steering.host", () => ({
  createSteeringHost: () => mocks.host,
}));
vi.mock("./migrate", () => ({ migrate: mocks.migrate }));

import { serverFolderNames, toolMigrationDeps } from "./migration-deps";
import { TOOL_MIGRATION_SETTING, type ToolMigrationRecord } from "./migration-run";

const SCOPE = { orgId: "org_1", workspaceId: "ws_1" };
const REPO = { fullName: "acme/oxagen-support", defaultBranch: "main" };
const RECORD: ToolMigrationRecord = {
  status: "running",
  prs: [],
  error: null,
  updated_at: "2026-10-01T12:00:00.000Z",
};
const PR = { number: 12, url: "https://github.com/acme/oxagen-support/pull/12", branch: "tools/migrate-servers-1" };

/** A query chain that records each call's argument and resolves to `rows`. */
function chain(rows: unknown[]): { tx: unknown; calls: Record<string, unknown> } {
  const calls: Record<string, unknown> = {};
  const tx: Record<string, unknown> = {};
  for (const step of ["select", "from", "update", "set", "where", "limit", "returning"]) {
    tx[step] = (arg: unknown) => {
      calls[step] = arg;
      return tx;
    };
  }
  // The chain is awaited after where(), limit(), or returning().
  tx["then"] = (resolve: (value: unknown) => unknown) => resolve(rows);
  return { tx, calls };
}

function useRows(rows: unknown[]): Record<string, unknown> {
  const { tx, calls } = chain(rows);
  mocks.withTenantDb.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx));
  return calls;
}

const render = (value: unknown) => new PgDialect().sqlToQuery(value as SQL);

function opener() {
  return {
    hasSteeringRepo: vi.fn().mockResolvedValue(true),
    open: vi.fn().mockResolvedValue(PR),
    readFile: vi.fn().mockResolvedValue("schema = 1"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.steeringPrOpener.mockReturnValue(opener());
  mocks.host.resolveRepository.mockResolvedValue(REPO);
});

describe("serverFolderNames", () => {
  it("names each folder under tools/servers/ once, in name order", () => {
    expect(
      serverFolderNames([
        "tools/servers/linear/server.toml",
        "tools/servers/github/tools.toml",
        "tools/servers/linear/tools.lock.json",
        "tools/servers/README.md",
        "tools/toolbelts/default.toml",
      ]),
    ).toEqual(["github", "linear"]);
  });

  it("names nothing when the folder is empty", () => {
    expect(serverFolderNames([])).toEqual([]);
  });
});

describe("hasSteeringRepo", () => {
  it("asks the registered opener", async () => {
    const registered = opener();
    registered.hasSteeringRepo.mockResolvedValue(false);
    mocks.steeringPrOpener.mockReturnValue(registered);

    await expect(toolMigrationDeps().hasSteeringRepo(SCOPE)).resolves.toBe(false);
    expect(registered.hasSteeringRepo).toHaveBeenCalledWith(SCOPE);
  });

  it("refuses when boot registered no opener", async () => {
    mocks.steeringPrOpener.mockReturnValue(null);

    await expect(toolMigrationDeps().hasSteeringRepo(SCOPE)).rejects.toMatchObject({
      code: "conflict",
      reason: "steering_pr_unavailable",
    });
  });
});

describe("movableServers", () => {
  it("reads the rows steeringWriter counts, in the tenant scope", async () => {
    const rows = [{ id: "srv_1", name: "Linear", steeringName: null }];
    const tx = { marker: true };
    mocks.withTenantDb.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx));
    mocks.listMovableLegacyServers.mockResolvedValue(rows);

    await expect(toolMigrationDeps().movableServers(SCOPE)).resolves.toBe(rows);
    expect(mocks.listMovableLegacyServers).toHaveBeenCalledWith(tx, SCOPE);
  });
});

describe("readRecord", () => {
  it("reads the tool_migration setting of the scope's workspace", async () => {
    const calls = useRows([{ settings: { [TOOL_MIGRATION_SETTING]: RECORD, steering_repo: {} } }]);

    await expect(toolMigrationDeps().readRecord(SCOPE)).resolves.toEqual(RECORD);
    const where = render(calls["where"]);
    expect(where.params).toEqual(expect.arrayContaining(["ws_1", "org_1"]));
    expect(calls["limit"]).toBe(1);
  });

  it("reads no record when the workspace row is missing", async () => {
    useRows([]);
    await expect(toolMigrationDeps().readRecord(SCOPE)).resolves.toBeNull();
  });
});

describe("claim", () => {
  const STALE = new Date("2026-10-01T11:50:00.000Z");

  it("writes the record when no fresh run holds the workspace", async () => {
    const calls = useRows([{ id: "ws_1" }]);

    await expect(toolMigrationDeps().claim(SCOPE, RECORD, STALE)).resolves.toBe(true);

    const set = render((calls["set"] as { settings: unknown }).settings);
    expect(set.sql).toContain("||");
    expect(set.params).toContain(JSON.stringify({ [TOOL_MIGRATION_SETTING]: RECORD }));
    const where = render(calls["where"]);
    expect(where.sql).toContain("'running'");
    expect(where.params).toEqual(
      expect.arrayContaining([
        "ws_1",
        "org_1",
        `{${TOOL_MIGRATION_SETTING},status}`,
        `{${TOOL_MIGRATION_SETTING},updated_at}`,
        STALE.toISOString(),
      ]),
    );
  });

  it("answers false when another run holds the workspace", async () => {
    useRows([]);
    await expect(toolMigrationDeps().claim(SCOPE, RECORD, STALE)).resolves.toBe(false);
  });
});

describe("saveRecord", () => {
  it("merges the record into the workspace's settings", async () => {
    const calls = useRows([]);
    const done: ToolMigrationRecord = { ...RECORD, status: "done", prs: [PR] };

    await toolMigrationDeps().saveRecord(SCOPE, done);

    const set = render((calls["set"] as { settings: unknown }).settings);
    expect(set.params).toContain(JSON.stringify({ [TOOL_MIGRATION_SETTING]: done }));
    expect(render(calls["where"]).params).toEqual(expect.arrayContaining(["ws_1", "org_1"]));
  });
});

describe("the steering host", () => {
  it("reads whether a PR is open and whether it merged", async () => {
    mocks.host.getPullRequest.mockResolvedValue({ open: false, merged: true, baseRef: "main" });

    await expect(toolMigrationDeps().pullRequestState(SCOPE, 12)).resolves.toEqual({
      open: false,
      merged: true,
    });
    expect(mocks.host.resolveRepository).toHaveBeenCalledWith(SCOPE);
    expect(mocks.host.getPullRequest).toHaveBeenCalledWith(REPO, 12);
  });

  it("lists the server folders on the default branch", async () => {
    mocks.host.listFiles.mockResolvedValue([
      "tools/servers/linear/server.toml",
      "tools/servers/github/server.toml",
    ]);

    await expect(toolMigrationDeps().serverFolders(SCOPE)).resolves.toEqual(["github", "linear"]);
    expect(mocks.host.listFiles).toHaveBeenCalledWith(REPO, "main", "tools/servers");
  });
});

describe("migrate", () => {
  it("records each PR through onOpened before migrate() goes on, and answers what it moved", async () => {
    const registered = opener();
    mocks.steeringPrOpener.mockReturnValue(registered);
    const order: string[] = [];
    registered.open.mockImplementation(async () => {
      order.push("open");
      return PR;
    });
    const onOpened = vi.fn(async () => {
      order.push("recorded");
    });
    mocks.migrate.mockImplementation(async (_scope, options) => {
      const wrapped = options.opener;
      expect(await wrapped.hasSteeringRepo(SCOPE)).toBe(true);
      expect(await wrapped.readFile(SCOPE, "tools/servers/x/server.toml")).toBe("schema = 1");
      const opened = await wrapped.open({ ...SCOPE, actorUserId: null, branch: "b", title: "t", body: "", files: [] });
      order.push("marked");
      return {
        opened: [opened],
        plan: {
          batches: [{ folders: [{ serverId: "srv_1" }, { serverId: "srv_2" }] }],
          notMoved: [{ name: "Files", reason: "it runs as a local process (stdio)." }],
          toolsNotMoved: [],
        },
      };
    });

    const result = await toolMigrationDeps().migrate(SCOPE, {
      existingFolders: ["github"],
      actorUserId: "usr_1",
      onOpened,
    });

    expect(result).toEqual({
      opened: [PR],
      movedServerIds: ["srv_1", "srv_2"],
      notMoved: [{ name: "Files", reason: "it runs as a local process (stdio)." }],
    });
    expect(order).toEqual(["open", "recorded", "marked"]);
    expect(onOpened).toHaveBeenCalledWith(PR);
    expect(mocks.migrate).toHaveBeenCalledWith(SCOPE, {
      opener: expect.any(Object),
      existingFolders: ["github"],
      actorUserId: "usr_1",
    });
  });

  it("refuses when boot registered no opener, before it loads migrate()", async () => {
    mocks.steeringPrOpener.mockReturnValue(null);

    await expect(
      toolMigrationDeps().migrate(SCOPE, { existingFolders: [], actorUserId: null, onOpened: vi.fn() }),
    ).rejects.toMatchObject({ reason: "steering_pr_unavailable" });
    expect(mocks.migrate).not.toHaveBeenCalled();
  });
});
