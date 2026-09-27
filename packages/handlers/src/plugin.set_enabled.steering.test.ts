import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Enabling a plugin in a workspace whose tools live in its steering repo
// opens a steering PR instead of writing an enabled row (M13, #4478).

vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  emitSecurityEvent: vi.fn(),
  steeringWriter: vi.fn(),
  addServer: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
  emitSecurityEventAsync: vi.fn(),
  makeSecurityEventInserter: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock("@oxagen/agent/runtime/steering-pr", () => ({
  MOVABLE_TRANSPORTS: ["streamable-http", "sse"],
  steeringWriter: mocks.steeringWriter,
}));

import { handler } from "./plugin.set_enabled";

const ctx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api" as const,
  messageId: null,
};

const LISTING = {
  id: "porg-1",
  orgId: "org-1",
  workspaceId: "ws-1",
  name: "Linear",
  pluginType: "mcp_server",
  enabled: true,
  endpointUrl: "https://mcp.linear.app/sse",
  transport: "sse",
  authKind: "oauth",
  deletedAt: null,
};

const PR = { number: 12, url: "https://github.com/acme/steering/pull/12", branch: "tools/add-server-linear-x" };

const ENABLE = { scope: "workspace", orgListingId: "porg-1", enabled: true };

interface TxEntry {
  op: "select" | "update" | "insert";
  set?: Record<string, unknown>;
  values?: Record<string, unknown>;
  conflictSet?: Record<string, unknown>;
}

let txLog: TxEntry[] = [];

/** A query-builder double: every chain resolves to `result` and records what it wrote. */
function fakeTx(result: unknown[]): unknown {
  const entry: TxEntry = { op: "select" };
  txLog.push(entry);
  const chain: Record<string, unknown> = {};
  const same = () => chain;
  Object.assign(chain, {
    select: () => {
      entry.op = "select";
      return chain;
    },
    update: () => {
      entry.op = "update";
      return chain;
    },
    insert: () => {
      entry.op = "insert";
      return chain;
    },
    set: (v: Record<string, unknown>) => {
      entry.set = v;
      return chain;
    },
    values: (v: Record<string, unknown>) => {
      entry.values = v;
      return chain;
    },
    from: same,
    where: same,
    onConflictDoNothing: same,
    onConflictDoUpdate: (c: { set: Record<string, unknown> }) => {
      entry.conflictSet = c.set;
      return chain;
    },
    limit: () => Promise.resolve(result),
    returning: () => Promise.resolve(result),
    then: (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) =>
      Promise.resolve(result).then(ok, fail),
  });
  return chain;
}

/** One withTenantDb call per result, in order. */
function queue(...results: unknown[][]): void {
  for (const result of results) {
    mocks.withTenantDb.mockImplementationOnce(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(fakeTx(result)),
    );
  }
}

function existingRow(overrides: Record<string, unknown>) {
  return {
    id: "srv-2",
    publicId: "mcp-pub-2",
    origin: "legacy",
    steeringName: null,
    enabled: false,
    deletedAt: null,
    deletedById: null,
    ...overrides,
  };
}

describe("set_plugin_enabled (workspace) once tools live in the steering repo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withTenantDb.mockReset();
    txLog = [];
    mocks.steeringWriter.mockResolvedValue({ addServer: mocks.addServer, addTools: vi.fn() });
    mocks.addServer.mockResolvedValue(PR);
  });

  it("writes a proposed, disabled row and opens a steering PR for a new server", async () => {
    queue([LISTING], [], [{ id: "srv-1", publicId: "mcp-pub-1" }]);

    const result = await handler(ENABLE, ctx);

    expect(result).toEqual({
      ok: true,
      workspaceServerId: "mcp-pub-1",
      steeringPr: { number: 12, url: PR.url },
    });
    expect(mocks.steeringWriter).toHaveBeenCalledWith({ orgId: "org-1", workspaceId: "ws-1" });
    expect(txLog[2]).toMatchObject({
      op: "insert",
      values: { origin: "proposed", enabled: false, orgListingId: "porg-1", transportType: "sse" },
    });
    expect(mocks.addServer).toHaveBeenCalledWith({
      orgId: "org-1",
      workspaceId: "ws-1",
      serverId: "srv-1",
      actorUserId: "user-1",
    });
    expect(mocks.emitSecurityEvent).toHaveBeenCalledTimes(1);
  });

  it("turns a disabled legacy row into a proposal and keeps its id", async () => {
    queue([LISTING], [existingRow({})], []);

    const result = (await handler(ENABLE, ctx)) as { workspaceServerId: string };

    expect(result.workspaceServerId).toBe("mcp-pub-2");
    expect(txLog[2]).toMatchObject({
      op: "update",
      set: { origin: "proposed", enabled: false, steeringName: null, deletedAt: null, deletedById: null },
    });
    expect(mocks.addServer).toHaveBeenCalledWith(expect.objectContaining({ serverId: "srv-2" }));
  });

  it("brings back a soft-deleted row as a proposal", async () => {
    queue([LISTING], [existingRow({ origin: "steering", steeringName: "linear", deletedAt: new Date() })], []);

    await handler(ENABLE, ctx);

    expect(txLog[2]).toMatchObject({ op: "update", set: { origin: "proposed", deletedAt: null } });
    expect(mocks.addServer).toHaveBeenCalledTimes(1);
  });

  it("toggles a live steering row on directly", async () => {
    queue([LISTING], [existingRow({ origin: "steering", steeringName: "linear" })], [{ publicId: "mcp-pub-2" }]);

    const result = await handler(ENABLE, ctx);

    expect(result).toEqual({ ok: true, workspaceServerId: "mcp-pub-2" });
    expect(mocks.addServer).not.toHaveBeenCalled();
    expect(txLog[2]).toMatchObject({ op: "insert" });
  });

  it("toggles a legacy row a migration PR named on directly", async () => {
    queue([LISTING], [existingRow({ steeringName: "linear" })], [{ publicId: "mcp-pub-2" }]);

    await handler(ENABLE, ctx);

    expect(mocks.addServer).not.toHaveBeenCalled();
  });

  it("refuses while the row's steering PR is open", async () => {
    queue([LISTING], [existingRow({ origin: "proposed", steeringName: "linear" })]);

    await expect(handler(ENABLE, ctx)).rejects.toMatchObject({
      code: "conflict",
      reason: "steering_pr_open",
    });
    expect(mocks.addServer).not.toHaveBeenCalled();
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("refuses when another request inserted the row first", async () => {
    queue([LISTING], [], []);

    await expect(handler(ENABLE, ctx)).rejects.toMatchObject({ reason: "plugin_enable_in_progress" });
    expect(mocks.addServer).not.toHaveBeenCalled();
  });

  it("soft-deletes the row it inserted when the PR does not open", async () => {
    const refusal = Object.assign(new Error("cannot hold it"), { code: "conflict", reason: "server_not_movable" });
    mocks.addServer.mockRejectedValue(refusal);
    queue([LISTING], [], [{ id: "srv-1", publicId: "mcp-pub-1" }], []);

    await expect(handler(ENABLE, ctx)).rejects.toBe(refusal);

    expect(txLog[3]?.op).toBe("update");
    expect(txLog[3]?.set?.deletedAt).toBeInstanceOf(Date);
    expect(txLog[3]?.set?.deletedById).toBe("user-1");
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("restores a converted row when the PR does not open", async () => {
    mocks.addServer.mockRejectedValue(new Error("GitHub is down"));
    queue([LISTING], [existingRow({})], [], []);

    await expect(handler(ENABLE, ctx)).rejects.toThrow("GitHub is down");

    expect(txLog[3]).toMatchObject({
      op: "update",
      set: { origin: "legacy", enabled: false, steeringName: null, deletedAt: null, deletedById: null },
    });
  });

  it("still rethrows the PR error when the rollback fails", async () => {
    mocks.addServer.mockRejectedValue(new Error("GitHub is down"));
    queue([LISTING], [], [{ id: "srv-1", publicId: "mcp-pub-1" }]);
    mocks.withTenantDb.mockImplementationOnce(async () => {
      throw new Error("db gone");
    });

    await expect(handler(ENABLE, ctx)).rejects.toThrow("GitHub is down");
  });

  it("writes an enabled row directly when the workspace has not migrated", async () => {
    mocks.steeringWriter.mockResolvedValue(null);
    queue([LISTING], [{ publicId: "mcp-pub-1" }]);

    const result = await handler(ENABLE, ctx);

    expect(result).toEqual({ ok: true, workspaceServerId: "mcp-pub-1" });
    expect(txLog[1]).toMatchObject({ op: "insert", values: { enabled: true } });
    expect(txLog[1]?.values?.origin).toBeUndefined();
    // An existing proposal the upsert enables becomes a legacy row.
    const origin = new PgDialect().sqlToQuery(txLog[1]?.conflictSet?.origin as SQL).sql;
    expect(origin).toMatch(/CASE WHEN .*"origin" = 'proposed' THEN 'legacy' ELSE .*"origin" END/);
  });

  it("never asks for a writer for a stdio plugin", async () => {
    queue([{ ...LISTING, transport: "stdio" }], [{ publicId: "mcp-pub-1" }]);

    await handler(ENABLE, ctx);

    expect(mocks.steeringWriter).not.toHaveBeenCalled();
    expect(mocks.addServer).not.toHaveBeenCalled();
  });

  it("disables directly without asking for a writer", async () => {
    queue([LISTING], []);

    await handler({ ...ENABLE, enabled: false }, ctx);

    expect(mocks.steeringWriter).not.toHaveBeenCalled();
    expect(txLog[1]).toMatchObject({ op: "update", set: { enabled: false } });
  });
});
