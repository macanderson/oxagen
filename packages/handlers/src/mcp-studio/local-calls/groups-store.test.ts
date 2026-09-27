// groups-store.ts against a faked tenant transaction: the refusals for an
// unknown and a revoked machine, the no-op paths, the grouping of listed rows,
// and the reader's filter. Each query the store builds resolves to the next
// programmed result. groups-store.pg.test.ts runs the same rules against a
// real Postgres.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { isHandlerError } from "@oxagen/oxagen";
import type { Tx } from "@oxagen/database";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import {
  postgresMachineGroupReader,
  postgresMachineGroupStore,
} from "./groups-store";

const SCOPE = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};
const MACHINE = "tch_4q8r1t6v3x5z0b2d7h2k9m";
const HOST_ID = "00000000-0000-4000-8000-0000000000b1";
const JOINED = new Date("2026-09-27T09:00:00.000Z");

/** One call on the fake transaction: the method and the arguments it took. */
type Call = { method: string; args: unknown[] };

/**
 * A transaction whose every query resolves to the next entry of `results`.
 * Each builder method is recorded, so a test can read what the store built.
 */
function fakeTx(results: unknown[][]) {
  const calls: Call[] = [];
  const queue = [...results];
  const query = (): unknown => {
    const result = queue.shift();
    if (result === undefined) throw new Error("the store ran one query more than the test programmed");
    const builder: unknown = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then")
            return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              Promise.resolve(result).then(resolve, reject);
          return (...args: unknown[]) => {
            calls.push({ method: String(prop), args });
            return builder;
          };
        },
      },
    );
    return builder;
  };
  const start =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return query();
    };
  const tx = {
    select: start("select"),
    selectDistinct: start("selectDistinct"),
    insert: start("insert"),
    delete: start("delete"),
  };
  return { tx: tx as unknown as Tx, calls, remaining: () => queue.length };
}

const dialect = new PgDialect();

/** The SQL text and parameters of the last `where` the store built. */
function lastWhere(calls: Call[]) {
  const where = calls.filter((c) => c.method === "where").at(-1);
  if (!where) throw new Error("the store built no where clause");
  return dialect.sqlToQuery(where.args[0] as SQL);
}

async function refusal(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!isHandlerError(err)) throw new Error(`expected a HandlerError, got ${String(err)}`);
  return err;
}

describe("postgresMachineGroupStore.addMachineToGroup", () => {
  const input = { group: "dev-laptops", machineId: MACHINE, addedByUserId: "u_1" };

  it("refuses a machine the workspace never enrolled, and writes nothing", async () => {
    const { tx, calls } = fakeTx([[]]);
    const err = await refusal(postgresMachineGroupStore(tx).addMachineToGroup(SCOPE, input));
    expect(err).toMatchObject({ code: "not_found", reason: "machine_not_found" });
    expect(err.message).toContain(MACHINE);
    expect(calls.some((c) => c.method === "insert")).toBe(false);
  });

  it("refuses a revoked machine, and writes nothing", async () => {
    const { tx, calls } = fakeTx([[{ id: HOST_ID, status: "revoked" }]]);
    const err = await refusal(postgresMachineGroupStore(tx).addMachineToGroup(SCOPE, input));
    expect(err).toMatchObject({ code: "conflict", reason: "machine_revoked" });
    expect(calls.some((c) => c.method === "insert")).toBe(false);
  });

  it("inserts the membership with the scope and the acting user", async () => {
    const { tx, calls } = fakeTx([[{ id: HOST_ID, status: "paused" }], [{ createdAt: JOINED }]]);
    await expect(postgresMachineGroupStore(tx).addMachineToGroup(SCOPE, input)).resolves.toEqual({
      addedAt: JOINED,
      added: true,
    });
    const values = calls.find((c) => c.method === "values");
    expect(values?.args[0]).toEqual({
      orgId: SCOPE.orgId,
      workspaceId: SCOPE.workspaceId,
      groupName: "dev-laptops",
      hostId: HOST_ID,
      createdById: "u_1",
    });
    expect(calls.some((c) => c.method === "onConflictDoNothing")).toBe(true);
  });

  it("answers the existing row when the machine is already in the group", async () => {
    const { tx, remaining } = fakeTx([
      [{ id: HOST_ID, status: "active" }],
      [],
      [{ createdAt: JOINED }],
    ]);
    await expect(postgresMachineGroupStore(tx).addMachineToGroup(SCOPE, input)).resolves.toEqual({
      addedAt: JOINED,
      added: false,
    });
    expect(remaining()).toBe(0);
  });

  it("asks for a retry when the conflicting row is gone before it is read", async () => {
    const { tx } = fakeTx([[{ id: HOST_ID, status: "active" }], [], []]);
    const err = await refusal(postgresMachineGroupStore(tx).addMachineToGroup(SCOPE, input));
    expect(err).toMatchObject({ code: "conflict", reason: "membership_changed" });
  });
});

describe("postgresMachineGroupStore.removeMachineFromGroup", () => {
  const input = { group: "dev-laptops", machineId: MACHINE };

  it("answers false for an unknown machine without a delete", async () => {
    const { tx, calls } = fakeTx([[]]);
    await expect(postgresMachineGroupStore(tx).removeMachineFromGroup(SCOPE, input)).resolves.toBe(
      false,
    );
    expect(calls.some((c) => c.method === "delete")).toBe(false);
  });

  it("answers false when the machine is not in the group", async () => {
    const { tx } = fakeTx([[{ id: HOST_ID, status: "revoked" }], []]);
    await expect(postgresMachineGroupStore(tx).removeMachineFromGroup(SCOPE, input)).resolves.toBe(
      false,
    );
  });

  it("answers true when a membership was deleted", async () => {
    const { tx } = fakeTx([[{ id: HOST_ID, status: "active" }], [{ id: "m_1" }]]);
    await expect(postgresMachineGroupStore(tx).removeMachineFromGroup(SCOPE, input)).resolves.toBe(
      true,
    );
  });
});

describe("postgresMachineGroupStore.listMachineGroups", () => {
  it("folds the sorted rows into one entry per group", async () => {
    const row = (group: string, machineId: string, status = "active") => ({
      group,
      machineId,
      hostname: `${machineId}.local`,
      status,
      addedAt: JOINED,
    });
    const { tx } = fakeTx([
      [row("ci-runners", "tch_a"), row("dev-laptops", "tch_a"), row("dev-laptops", "tch_b", "revoked")],
    ]);
    const groups = await postgresMachineGroupStore(tx).listMachineGroups(SCOPE, {});
    expect(groups.map((g) => [g.group, g.machines.map((m) => m.machineId)])).toEqual([
      ["ci-runners", ["tch_a"]],
      ["dev-laptops", ["tch_a", "tch_b"]],
    ]);
    expect(groups[1]?.machines[1]).toEqual({
      machineId: "tch_b",
      hostname: "tch_b.local",
      status: "revoked",
      addedAt: JOINED,
    });
  });

  it("filters by the scope, and by the group when one is named", async () => {
    const { tx, calls } = fakeTx([[]]);
    await expect(
      postgresMachineGroupStore(tx).listMachineGroups(SCOPE, { group: "ci-runners" }),
    ).resolves.toEqual([]);
    const { params } = lastWhere(calls);
    expect(params).toEqual(expect.arrayContaining([SCOPE.orgId, SCOPE.workspaceId, "ci-runners"]));
  });
});

describe("postgresMachineGroupReader.groupsOf", () => {
  beforeEach(() => mocks.withTenantDb.mockReset());

  it("reads the machine's groups inside the scope and skips a revoked host", async () => {
    const { tx, calls } = fakeTx([[{ group: "ci-runners" }, { group: "dev-laptops" }]]);
    mocks.withTenantDb.mockImplementation((fn: (tx: Tx) => unknown) => fn(tx));

    await expect(postgresMachineGroupReader.groupsOf(SCOPE, MACHINE)).resolves.toEqual([
      "ci-runners",
      "dev-laptops",
    ]);
    expect(calls[0]?.method).toBe("selectDistinct");
    const { sql, params } = lastWhere(calls);
    expect(params).toEqual(
      expect.arrayContaining([SCOPE.orgId, SCOPE.workspaceId, MACHINE, "revoked"]),
    );
    expect(sql).toMatch(/"status" <> \$\d+/);
  });

  it("answers no groups for a machine with no membership", async () => {
    const { tx } = fakeTx([[]]);
    mocks.withTenantDb.mockImplementation((fn: (tx: Tx) => unknown) => fn(tx));
    await expect(postgresMachineGroupReader.groupsOf(SCOPE, MACHINE)).resolves.toEqual([]);
  });
});
