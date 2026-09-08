import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for agent ↔ environment bindings.
 *
 * `withTenantDb` is replaced by a fake transaction that serves each terminal
 * `select` from a FIFO queue (the module issues several differently-shaped
 * selects per call) and records every `update` / `insert` / `delete` so the
 * primary-promotion ordering and the identifier-resolution branches can be
 * asserted without a live database. The real `schema` is kept.
 */
interface Captures {
  selectQueue: Record<string, unknown>[][];
  updates: { set: Record<string, unknown> }[];
  inserts: Record<string, unknown>[];
  updateReturning: Record<string, unknown>[];
  insertReturning: Record<string, unknown>[];
  deletes: number;
}

const state: Captures = {
  selectQueue: [],
  updates: [],
  inserts: [],
  updateReturning: [],
  insertReturning: [],
  deletes: 0,
};

function nextRows(): Record<string, unknown>[] {
  return state.selectQueue.shift() ?? [];
}

function makeTx() {
  const selectBuilder = () => {
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      from: () => b,
      where: () => b,
      limit: async () => nextRows(),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(nextRows()).then(res, rej),
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
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        state.inserts.push(v);
        return { returning: async () => state.insertReturning };
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

const AGENT_UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const actor = { orgId: "o1", workspaceId: "w1", userId: "u1" };

const envRow = {
  id: "env_int_1",
  name: "Production",
  slug: "production",
  isActive: true,
};

beforeEach(() => {
  state.selectQueue = [];
  state.updates = [];
  state.inserts = [];
  state.updateReturning = [];
  state.insertReturning = [];
  state.deletes = 0;
});

describe("bindAgentEnvironment", () => {
  it("inserts the first binding as primary and returns the resolved summary", async () => {
    const { bindAgentEnvironment } = await import(
      "./agent-environment-binding"
    );
    state.selectQueue = [
      [envRow], // loadEnvironment (agent id is already a UUID, no agent lookup)
      [], // existing bindings for the agent: none
      [
        {
          id: "b_int_1",
          publicId: "aeb_1",
          agentId: AGENT_UUID,
          environmentInternalId: "env_int_1",
          isPrimary: true,
        },
      ], // re-read of the written row
      [{ publicId: "env_pub_1", name: "Production", slug: "production" }],
    ];
    state.insertReturning = [{ publicId: "aeb_1" }];

    const result = await bindAgentEnvironment(actor, {
      agentId: AGENT_UUID,
      environmentId: "env_pub_1",
    });

    expect(result).toEqual({
      id: "aeb_1",
      agentId: AGENT_UUID,
      environmentId: "env_pub_1",
      environmentName: "Production",
      environmentSlug: "production",
      isPrimary: true,
    });
    // The binding is primary, so the demote sweep runs (a no-op with no
    // incumbent) before the insert.
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.set).toMatchObject({ isPrimary: false });
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({
      orgId: "o1",
      workspaceId: "w1",
      agentId: AGENT_UUID,
      environmentId: "env_int_1",
      isPrimary: true,
      createdByUserId: "u1",
      updatedByUserId: "u1",
    });
  });

  it("defaults isPrimary to false when the agent already has a primary binding", async () => {
    const { bindAgentEnvironment } = await import(
      "./agent-environment-binding"
    );
    state.selectQueue = [
      [envRow],
      [
        {
          id: "b_int_0",
          environmentInternalId: "env_other",
          isPrimary: true,
        },
      ],
      [
        {
          id: "b_int_1",
          publicId: "aeb_2",
          agentId: AGENT_UUID,
          environmentInternalId: "env_int_1",
          isPrimary: false,
        },
      ],
      [{ publicId: "env_pub_1", name: "Production", slug: "production" }],
    ];
    state.insertReturning = [{ publicId: "aeb_2" }];

    const result = await bindAgentEnvironment(actor, {
      agentId: AGENT_UUID,
      environmentId: "env_pub_1",
    });

    expect(result.isPrimary).toBe(false);
    expect(state.updates).toHaveLength(0);
    expect(state.inserts[0]).toMatchObject({ isPrimary: false });
  });

  it("demotes the current primary and updates an existing binding in place", async () => {
    const { bindAgentEnvironment } = await import(
      "./agent-environment-binding"
    );
    state.selectQueue = [
      [{ id: AGENT_UUID }], // resolveAgentInternalId via agt_ public id
      [envRow],
      [
        { id: "b_int_9", environmentInternalId: "env_other", isPrimary: true },
        { id: "b_int_1", environmentInternalId: "env_int_1", isPrimary: false },
      ],
      [
        {
          id: "b_int_1",
          publicId: "aeb_3",
          agentId: AGENT_UUID,
          environmentInternalId: "env_int_1",
          isPrimary: true,
        },
      ],
      [{ publicId: "env_pub_1", name: "Production", slug: "production" }],
    ];
    state.updateReturning = [{ publicId: "aeb_3" }];

    const result = await bindAgentEnvironment(
      { orgId: "o1", workspaceId: "w1" },
      { agentId: "agt_abc", environmentId: "env_pub_1", isPrimary: true },
    );

    expect(result.id).toBe("aeb_3");
    expect(result.isPrimary).toBe(true);
    expect(state.inserts).toHaveLength(0);
    // First update demotes the incumbent primary, second promotes this binding.
    expect(state.updates).toHaveLength(2);
    expect(state.updates[0]!.set).toMatchObject({
      isPrimary: false,
      updatedByUserId: null,
    });
    expect(state.updates[1]!.set).toMatchObject({
      isPrimary: true,
      updatedByUserId: null,
    });
  });

  it("falls back to the internal environment id when the environment re-read misses", async () => {
    const { bindAgentEnvironment } = await import(
      "./agent-environment-binding"
    );
    state.selectQueue = [
      [envRow],
      [],
      [
        {
          id: "b_int_1",
          publicId: "aeb_4",
          agentId: AGENT_UUID,
          environmentInternalId: "env_int_1",
          isPrimary: true,
        },
      ],
      [], // environment lookup for the summary returns nothing
    ];
    state.insertReturning = [{ publicId: "aeb_4" }];

    const result = await bindAgentEnvironment(actor, {
      agentId: AGENT_UUID,
      environmentId: "env_pub_1",
    });

    expect(result.environmentId).toBe("env_int_1");
    expect(result.environmentName).toBe("");
    expect(result.environmentSlug).toBe("");
  });

  it("throws when the environment public id resolves to nothing", async () => {
    const { bindAgentEnvironment } = await import(
      "./agent-environment-binding"
    );
    state.selectQueue = [[]];

    await expect(
      bindAgentEnvironment(actor, {
        agentId: AGENT_UUID,
        environmentId: "env_missing",
      }),
    ).rejects.toThrow("[agent-environment] environment not found: env_missing");
  });

  it("throws when the agent slug resolves to nothing", async () => {
    const { bindAgentEnvironment } = await import(
      "./agent-environment-binding"
    );
    state.selectQueue = [[]];

    await expect(
      bindAgentEnvironment(actor, {
        agentId: "nightly-auditor",
        environmentId: "env_pub_1",
      }),
    ).rejects.toThrow("[agent-environment] agent not found: nightly-auditor");
  });
});

describe("unbindAgentEnvironment", () => {
  it("deletes the binding for the resolved agent and environment", async () => {
    const { unbindAgentEnvironment } = await import(
      "./agent-environment-binding"
    );
    state.selectQueue = [[{ id: AGENT_UUID }], [envRow]];

    await expect(
      unbindAgentEnvironment(actor, {
        agentId: "nightly-auditor",
        environmentId: "env_pub_1",
      }),
    ).resolves.toEqual({ ok: true });
    expect(state.deletes).toBe(1);
  });

  it("propagates a missing-environment failure without deleting", async () => {
    const { unbindAgentEnvironment } = await import(
      "./agent-environment-binding"
    );
    state.selectQueue = [[]];

    await expect(
      unbindAgentEnvironment(actor, {
        agentId: AGENT_UUID,
        environmentId: "env_missing",
      }),
    ).rejects.toThrow("environment not found");
    expect(state.deletes).toBe(0);
  });
});

describe("listAgentBindings", () => {
  it("maps every binding row to a summary with its environment labels", async () => {
    const { listAgentBindings } = await import("./agent-environment-binding");
    state.selectQueue = [
      [
        {
          id: "b_int_1",
          publicId: "aeb_1",
          agentId: AGENT_UUID,
          environmentInternalId: "env_int_1",
          isPrimary: true,
        },
        {
          id: "b_int_2",
          publicId: "aeb_2",
          agentId: AGENT_UUID,
          environmentInternalId: "env_int_2",
          isPrimary: false,
        },
      ],
      [{ publicId: "env_pub_1", name: "Production", slug: "production" }],
      [{ publicId: "env_pub_2", name: "Staging", slug: "staging" }],
    ];

    const rows = await listAgentBindings(actor, { agentId: AGENT_UUID });

    expect(rows).toEqual([
      {
        id: "aeb_1",
        agentId: AGENT_UUID,
        environmentId: "env_pub_1",
        environmentName: "Production",
        environmentSlug: "production",
        isPrimary: true,
      },
      {
        id: "aeb_2",
        agentId: AGENT_UUID,
        environmentId: "env_pub_2",
        environmentName: "Staging",
        environmentSlug: "staging",
        isPrimary: false,
      },
    ]);
  });

  it("returns an empty list when the agent has no bindings", async () => {
    const { listAgentBindings } = await import("./agent-environment-binding");
    state.selectQueue = [[{ id: AGENT_UUID }], []];

    await expect(
      listAgentBindings(actor, { agentId: "agt_abc" }),
    ).resolves.toEqual([]);
  });
});
