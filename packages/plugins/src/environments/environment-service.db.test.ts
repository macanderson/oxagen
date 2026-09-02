import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock @oxagen/database so the service's tx logic is unit-testable without a
// live DB. We keep the real `schema` (and everything else) and only replace
// `withTenantDb` with a fake transaction that records the `.set()` clauses so we
// can assert the only-one-default swap ordering and the guard throws.
interface Captures {
  selectRows: Record<string, unknown>[];
  updateReturning: Record<string, unknown>[];
  updates: { set: Record<string, unknown> }[];
  deletes: number;
}
const state: Captures = {
  selectRows: [],
  updateReturning: [],
  updates: [],
  deletes: 0,
};

function makeTx() {
  const selectBuilder = () => {
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      from: () => b,
      where: () => b,
      limit: async () => state.selectRows,
      orderBy: async () => state.selectRows,
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(state.selectRows).then(res, rej),
    });
    return b;
  };
  return {
    select: () => selectBuilder(),
    update: () => ({
      set: (s: Record<string, unknown>) => {
        state.updates.push({ set: s });
        return {
          where: () => ({
            returning: async () => state.updateReturning,
            then: (
              res: (v: unknown) => unknown,
              rej: (e: unknown) => unknown,
            ) => Promise.resolve(undefined).then(res, rej),
          }),
        };
      },
    }),
    delete: () => ({
      where: () => {
        state.deletes += 1;
        return Promise.resolve(undefined);
      },
    }),
  };
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => unknown) => fn(makeTx()),
  };
});

const actor = { orgId: "o1", workspaceId: "w1", userId: "u1" };

beforeEach(() => {
  state.selectRows = [];
  state.updateReturning = [];
  state.updates = [];
  state.deletes = 0;
});

describe("setDefaultEnvironment — atomic swap", () => {
  it("clears the current default BEFORE promoting the target (and reactivates it)", async () => {
    const { setDefaultEnvironment } = await import("./environment-service");
    state.selectRows = [
      {
        id: "int_1",
        publicId: "env_pub_1",
        name: "Prod",
        slug: "production",
        description: null,
        isDefault: false,
        isActive: true,
      },
    ];
    state.updateReturning = [
      {
        id: "int_1",
        publicId: "env_pub_1",
        name: "Prod",
        slug: "production",
        description: null,
        isDefault: true,
        isActive: true,
      },
    ];

    const result = await setDefaultEnvironment(actor, {
      environmentId: "env_pub_1",
    });

    expect(result.id).toBe("env_pub_1");
    expect(result.isDefault).toBe(true);
    // Two updates in order: clear the old default, then set the new one.
    expect(state.updates).toHaveLength(2);
    expect(state.updates[0]!.set.isDefault).toBe(false);
    expect(state.updates[1]!.set.isDefault).toBe(true);
    // The promoted environment is always reactivated.
    expect(state.updates[1]!.set.isActive).toBe(true);
  });
});

describe("setDefaultEnvironment — actor without userId / missing row", () => {
  it("sets updatedByUserId to null on both updates when the actor has no userId", async () => {
    const { setDefaultEnvironment } = await import("./environment-service");
    const actorNoUser = { orgId: "o1", workspaceId: "w1" };
    state.selectRows = [
      {
        id: "int_1",
        publicId: "env_pub_1",
        name: "Prod",
        slug: "production",
        description: null,
        isDefault: false,
        isActive: true,
      },
    ];
    state.updateReturning = [
      {
        id: "int_1",
        publicId: "env_pub_1",
        name: "Prod",
        slug: "production",
        description: null,
        isDefault: true,
        isActive: true,
      },
    ];

    await setDefaultEnvironment(actorNoUser, { environmentId: "env_pub_1" });

    expect(state.updates).toHaveLength(2);
    expect(state.updates[0]!.set.updatedByUserId).toBeNull();
    expect(state.updates[1]!.set.updatedByUserId).toBeNull();
  });

  it("throws when the promote update returns no row", async () => {
    const { setDefaultEnvironment } = await import("./environment-service");
    state.selectRows = [
      {
        id: "int_1",
        publicId: "env_pub_1",
        name: "Prod",
        slug: "production",
        description: null,
        isDefault: false,
        isActive: true,
      },
    ];
    state.updateReturning = []; // .returning() came back empty

    await expect(
      setDefaultEnvironment(actor, { environmentId: "env_pub_1" }),
    ).rejects.toThrow(/set_default returned no row/);
  });
});

describe("default-environment guards", () => {
  const defaultRow = [
    {
      id: "int_1",
      publicId: "env_pub_1",
      name: "Prod",
      slug: "production",
      description: null,
      isDefault: true,
      isActive: true,
    },
  ];

  it("deleteEnvironment refuses to delete the default (no write issued)", async () => {
    const { deleteEnvironment } = await import("./environment-service");
    state.selectRows = defaultRow;
    await expect(
      deleteEnvironment(actor, { environmentId: "env_pub_1" }),
    ).rejects.toThrow(/cannot delete the default/);
    expect(state.updates).toHaveLength(0);
    expect(state.deletes).toBe(0);
  });

  it("updateEnvironment refuses to deactivate the default (no write issued)", async () => {
    const { updateEnvironment } = await import("./environment-service");
    state.selectRows = defaultRow;
    await expect(
      updateEnvironment(actor, { environmentId: "env_pub_1", isActive: false }),
    ).rejects.toThrow(/cannot deactivate the default/);
    expect(state.updates).toHaveLength(0);
  });
});
