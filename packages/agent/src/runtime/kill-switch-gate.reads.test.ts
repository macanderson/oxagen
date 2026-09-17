/**
 * The gate's Postgres reads: a snapshot is the generation vector, the active
 * switches and the classification index read on one repeatable-read
 * transaction, generation first. A snapshot assembled from separate
 * transactions could carry a post-flip generation beside pre-flip switches,
 * and the gate would then keep the stale switches for the rest of the turn.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ read: string; tx: unknown }>,
  withTenantDb: vi.fn(),
  withRepeatableReadTenantDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("@oxagen/database/tenant", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database/tenant")>();
  return {
    ...real,
    withRepeatableReadTenantDb: mocks.withRepeatableReadTenantDb,
  };
});
vi.mock("@oxagen/iam", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/iam")>();
  return {
    ...real,
    readDenyGenerationVector: vi.fn(async (tx: unknown) => {
      mocks.calls.push({ read: "generation", tx });
      return { org: 3, workspace: 1 };
    }),
    readActiveKillSwitches: vi.fn(async (tx: unknown) => {
      mocks.calls.push({ read: "switches", tx });
      return [];
    }),
  };
});

import { postgresKillSwitchReads } from "./kill-switch-gate";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-00000000ac40";
const SERVER = "0192d4a8-7c1e-7a00-8000-0000000000aa";

/** One transaction double; its select answers the classification join. */
function transaction(rows: unknown[]) {
  const tx = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => {
            mocks.calls.push({ read: "classification", tx });
            return Promise.resolve(rows);
          },
        }),
      }),
    }),
  };
  return tx;
}

beforeEach(() => {
  mocks.calls.length = 0;
  mocks.withTenantDb.mockReset();
  mocks.withRepeatableReadTenantDb.mockReset();
});

describe("postgresKillSwitchReads.readSnapshot", () => {
  it("reads the generation, the switches and the index on one repeatable-read transaction, generation first", async () => {
    const tx = transaction([
      {
        source: "mcp",
        slug: `mcp.${SERVER}.create_payment`,
        name: "create_payment",
        mcpServerId: SERVER,
        classification: { consequenceTags: ["moves_money", 7] },
      },
      {
        source: "custom",
        slug: "lookup_invoice",
        name: "lookup_invoice",
        mcpServerId: null,
        classification: { consequenceTags: "not a list" },
      },
    ]);
    mocks.withRepeatableReadTenantDb.mockImplementation(
      (fn: (t: unknown) => unknown) => fn(tx),
    );

    const snapshot = await postgresKillSwitchReads.readSnapshot({
      orgId: ORG,
      workspaceId: WS,
    });

    expect(mocks.withRepeatableReadTenantDb).toHaveBeenCalledTimes(1);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.calls.map((c) => c.read)).toEqual([
      "generation",
      "switches",
      "classification",
    ]);
    expect(mocks.calls.every((c) => c.tx === tx)).toBe(true);
    expect(snapshot.generation).toEqual({ org: 3, workspace: 1 });
    expect(snapshot.switches).toEqual([]);
    expect([...snapshot.tags]).toEqual([
      [`mcp.${SERVER}.create_payment`, ["moves_money"]],
    ]);
  });

  it("reads the generation alone on an ordinary tenant transaction", async () => {
    mocks.withTenantDb.mockImplementation((fn: (t: unknown) => unknown) =>
      fn({}),
    );
    const generation = await postgresKillSwitchReads.readGeneration({
      orgId: ORG,
      workspaceId: WS,
    });
    expect(generation).toEqual({ org: 3, workspace: 1 });
    expect(mocks.withRepeatableReadTenantDb).not.toHaveBeenCalled();
  });
});
