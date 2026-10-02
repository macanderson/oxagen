/**
 * proposeListingServer decides how a plugin listing's server is connected in
 * a workspace whose tools live in its steering repo (M13, #4478). Each
 * withTenantDb call gets a query-builder double that resolves to the next
 * queued result and records what it wrote, so the tests read the decision,
 * the writes, and the rollback in order.
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  addServer: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import {
  proposeListingServer,
  type ListingServerRequest,
} from "./steering-proposal";
import type { ServerFolderWriter } from "./steering-pr";

interface TxEntry {
  op: "select" | "update" | "insert";
  set?: Record<string, unknown>;
  values?: Record<string, unknown>;
  doNothing?: boolean;
  where?: SQL;
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
    where: (w: SQL) => {
      entry.where = w;
      return chain;
    },
    onConflictDoNothing: () => {
      entry.doNothing = true;
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
    mocks.withTenantDb.mockImplementationOnce(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx(result)),
    );
  }
}

function renderWhere(entry: TxEntry | undefined): {
  sql: string;
  params: unknown[];
} {
  return new PgDialect().sqlToQuery(entry?.where as SQL);
}

function existingRow(overrides: Record<string, unknown>) {
  return {
    id: "srv-2",
    publicId: "mcs_2",
    origin: "legacy",
    steeringName: null,
    enabled: false,
    deletedAt: null,
    deletedById: null,
    ...overrides,
  };
}

const PR = {
  number: 12,
  url: "https://github.com/acme/steering/pull/12",
  branch: "tools/add-server-linear-20261001t120000z",
};

const writer: ServerFolderWriter = {
  addServer: mocks.addServer,
  addTools: vi.fn(),
};

function request(
  overrides: Partial<ListingServerRequest> = {},
): ListingServerRequest {
  return {
    orgId: "org-1",
    workspaceId: "ws-1",
    userId: "user-1",
    listing: { id: "listing-1", name: "Linear" },
    values: {
      name: "Linear",
      transportType: "streamable-http",
      endpointUrl: "https://mcp.linear.app/mcp",
      authStrategy: "bearer",
      healthStatus: "healthy",
      discoveredTools: ["list_issues"],
    },
    refresh: { healthStatus: "healthy" },
    caller: "test",
    ...overrides,
  };
}

describe("proposeListingServer", () => {
  beforeEach(() => {
    mocks.withTenantDb.mockReset();
    mocks.addServer.mockReset();
    mocks.addServer.mockResolvedValue(PR);
    txLog = [];
  });

  it("leaves a live row the steering repo holds to the caller", async () => {
    for (const held of [
      existingRow({ origin: "steering", steeringName: "linear" }),
      existingRow({ origin: "legacy", steeringName: "linear" }),
    ]) {
      queue([held]);
      await expect(proposeListingServer(writer, request())).resolves.toEqual({
        kind: "held",
      });
    }
    expect(txLog.map((e) => e.op)).toEqual(["select", "select"]);
    expect(mocks.addServer).not.toHaveBeenCalled();
  });

  it("names the folder of a proposal whose steering PR is open, and writes nothing", async () => {
    queue([existingRow({ origin: "proposed", steeringName: "linear" })]);

    await expect(proposeListingServer(writer, request())).resolves.toEqual({
      kind: "pending",
      folder: "linear",
    });
    expect(txLog).toHaveLength(1);
    expect(mocks.addServer).not.toHaveBeenCalled();
  });

  it("inserts a proposed, disabled row, runs beforeOpen, then opens the PR", async () => {
    const order: string[] = [];
    const beforeOpen = vi.fn(async (serverId: string) => {
      order.push(`pin ${serverId}`);
    });
    mocks.addServer.mockImplementation(async () => {
      order.push("open");
      return PR;
    });
    queue([], [{ id: "srv-1", publicId: "mcs_1" }]);

    const outcome = await proposeListingServer(
      writer,
      request({ beforeOpen }),
    );

    expect(outcome).toEqual({
      kind: "proposed",
      serverId: "srv-1",
      publicId: "mcs_1",
      pr: PR,
    });
    expect(txLog[1]).toMatchObject({
      op: "insert",
      doNothing: true,
      values: {
        orgId: "org-1",
        workspaceId: "ws-1",
        orgListingId: "listing-1",
        origin: "proposed",
        enabled: false,
        authConfig: {},
        healthStatus: "healthy",
      },
    });
    expect(order).toEqual(["pin srv-1", "open"]);
    expect(mocks.addServer).toHaveBeenCalledWith({
      orgId: "org-1",
      workspaceId: "ws-1",
      serverId: "srv-1",
      actorUserId: "user-1",
    });
  });

  it("brings back a deleted row as a proposal, with the caller's refreshed columns", async () => {
    queue(
      [
        existingRow({
          origin: "steering",
          steeringName: "linear",
          deletedAt: new Date(),
        }),
      ],
      [{ id: "srv-2" }],
    );

    const outcome = await proposeListingServer(
      writer,
      request({ refresh: { name: "Linear", healthStatus: "degraded" } }),
    );

    expect(outcome).toMatchObject({ kind: "proposed", publicId: "mcs_2" });
    expect(txLog[1]).toMatchObject({
      op: "update",
      set: {
        origin: "proposed",
        enabled: false,
        steeringName: null,
        deletedAt: null,
        deletedById: null,
        name: "Linear",
        healthStatus: "degraded",
      },
    });
    // The conversion matches the origin and folder name it read.
    const where = renderWhere(txLog[1]);
    expect(where.sql).toMatch(/"steering_name" = \$\d+/);
    expect(where.params).toEqual(
      expect.arrayContaining(["steering", "linear"]),
    );
  });

  it("refuses when another request changed or inserted the row first", async () => {
    queue([existingRow({})], []);
    await expect(proposeListingServer(writer, request())).rejects.toMatchObject(
      { code: "conflict", reason: "plugin_enable_in_progress" },
    );

    queue([], []);
    await expect(proposeListingServer(writer, request())).rejects.toMatchObject(
      { code: "conflict", reason: "plugin_enable_in_progress" },
    );
    expect(mocks.addServer).not.toHaveBeenCalled();
  });

  it("soft-deletes an inserted row when the PR does not open", async () => {
    mocks.addServer.mockRejectedValue(new Error("GitHub is down"));
    queue([], [{ id: "srv-1", publicId: "mcs_1" }], []);

    await expect(proposeListingServer(writer, request())).rejects.toThrow(
      "GitHub is down",
    );

    expect(txLog[2]).toMatchObject({
      op: "update",
      set: { deletedAt: expect.any(Date), deletedById: "user-1" },
    });
    const where = renderWhere(txLog[2]);
    expect(where.sql).toMatch(/"steering_name" is null/);
    expect(where.params).toContain("proposed");
  });

  it("restores a converted row when beforeOpen throws, and opens no PR", async () => {
    queue([existingRow({})], [{ id: "srv-2" }], []);

    await expect(
      proposeListingServer(
        writer,
        request({
          beforeOpen: async () => {
            throw new Error("pin failed");
          },
        }),
      ),
    ).rejects.toThrow("pin failed");

    expect(mocks.addServer).not.toHaveBeenCalled();
    expect(txLog[2]).toMatchObject({
      op: "update",
      set: {
        origin: "legacy",
        enabled: false,
        steeringName: null,
        deletedAt: null,
        deletedById: null,
      },
    });
  });

  it("still rethrows the PR error when the rollback fails", async () => {
    mocks.addServer.mockRejectedValue(new Error("GitHub is down"));
    queue([], [{ id: "srv-1", publicId: "mcs_1" }]);
    mocks.withTenantDb.mockImplementationOnce(async () => {
      throw new Error("db gone");
    });

    await expect(proposeListingServer(writer, request())).rejects.toThrow(
      "GitHub is down",
    );
  });
});
