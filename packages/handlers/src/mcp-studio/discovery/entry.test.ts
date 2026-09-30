// entry.test.ts: where discovery starts and where Studio reads it (lane M10,
// #4682). The role gate, the tenant scope, the event client, and the run are
// doubles, so each case checks what entry.ts decides.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DiscoveryRow,
  DiscoveryStore,
  DiscoveryToolsStore,
  StoredTool,
} from "./store";

const roleGate = vi.hoisted(() => ({
  refuse: false,
  assertOrgRole: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (ctx: { userId?: string | null }) =>
    ctx.userId ?? null,
  assertOrgRole: roleGate.assertOrgRole.mockImplementation(async () => {
    if (roleGate.refuse) {
      throw Object.assign(new Error("forbidden: not a workspace member"), {
        code: "forbidden",
      });
    }
    return "Viewer";
  }),
}));

const tenancy = vi.hoisted(() => ({
  scopes: [] as { orgId: string; workspaceId: string }[],
}));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (
    scope: { orgId: string; workspaceId: string },
    fn: () => unknown,
  ) => {
    tenancy.scopes.push({ orgId: scope.orgId, workspaceId: scope.workspaceId });
    return fn();
  },
}));

const events = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../../event-client", () => ({ eventClient: { send: events.send } }));

const run = vi.hoisted(() => ({ runDiscovery: vi.fn() }));
vi.mock("./sync", () => ({ runDiscovery: run.runDiscovery }));

import {
  DAILY_MS,
  planDiscoverySweep,
  readServerDiscovery,
  readServerTools,
  listServerDiscoveries,
  requestDiscoveries,
  requestDiscovery,
  runDiscoveryEvent,
  STALLED_MS,
  startServerDiscovery,
  SWEEP_LIMIT,
  type DiscoveryActor,
} from "./entry";

const ORG = "0191d0a0-0000-7000-8000-000000000001";
const WS = "0191d0a0-0000-7000-8000-000000000002";
const SCOPE = { orgId: ORG, workspaceId: WS };
const ACTOR: DiscoveryActor = {
  orgId: ORG,
  workspaceId: WS,
  userId: "user_1",
  apiKeyId: null,
};
const NOW = new Date("2026-09-28T15:00:12Z");

const READ_ROLES = {
  org: ["Owner", "Admin"],
  workspace: ["Owner", "Member", "Viewer"],
};
const START_ROLES = {
  org: ["Owner", "Admin"],
  workspace: ["Owner", "Member"],
};

function row(server: string): DiscoveryRow {
  return {
    id: "0191d0a0-0000-7000-8000-00000000d15c",
    server,
    mcpServerId: null,
    status: "queued",
    trigger: "manual",
    requestedAt: NOW,
    requestedBy: "user_1",
    startedAt: null,
    finishedAt: null,
    error: null,
    outcome: null,
    toolCount: null,
    machine: null,
    sourceKind: null,
    sourceRepo: null,
    sourcePath: null,
    sourceRef: null,
    schedule: null,
    upstreamDigest: null,
    latestVersion: null,
    pr: null,
    withheld: [],
  };
}

function storeDouble(read: DiscoveryRow | null = null) {
  const store = {
    request: vi.fn(async () => {}),
    begin: vi.fn(async () => null),
    recordSource: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    read: vi.fn(async () => read),
    list: vi.fn(async () => (read === null ? [] : [read])),
    steeringServerId: vi.fn(async () => null),
    captureSnapshots: vi.fn(async () => 0),
  } satisfies DiscoveryStore;
  return store;
}

function tool(name: string, at: string, id = `snap_${name}`): StoredTool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
    annotations: null,
    snapshotId: id,
    capturedAt: new Date(at),
  };
}

function toolsDouble(tools: StoredTool[], withheldUpstream: string[] = []) {
  return {
    read: vi.fn(async () => ({ tools, withheldUpstream })),
  } satisfies DiscoveryToolsStore;
}

beforeEach(() => {
  roleGate.refuse = false;
  tenancy.scopes.length = 0;
});

describe("readServerTools", () => {
  it("lets a workspace Viewer read, in the workspace's scope", async () => {
    const tools = toolsDouble([tool("create_refund", "2026-09-28T14:00:00Z")]);

    const result = await readServerTools(ACTOR, "stripe", { tools });

    expect(roleGate.assertOrgRole).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS, userId: "user_1" },
      READ_ROLES,
    );
    expect(tenancy.scopes).toEqual([SCOPE]);
    expect(tools.read).toHaveBeenCalledWith(SCOPE, "stripe");
    expect(result.tools.map((t) => t.name)).toEqual(["create_refund"]);
  });

  it("refuses a caller outside the workspace before it reads a tool", async () => {
    roleGate.refuse = true;
    const tools = toolsDouble([tool("create_refund", "2026-09-28T14:00:00Z")]);

    await expect(readServerTools(ACTOR, "stripe", { tools })).rejects.toThrow(
      /forbidden/,
    );
    expect(tools.read).not.toHaveBeenCalled();
  });

  it("returns an empty list when no snapshot exists yet", async () => {
    const tools = toolsDouble([]);

    await expect(readServerTools(ACTOR, "stripe", { tools })).resolves.toEqual({
      server: "stripe",
      snapshotId: null,
      capturedAt: null,
      tools: [],
    });
  });

  it("marks the tools the gateway withholds until the steering PR merges", async () => {
    const tools = toolsDouble(
      [
        tool("create_refund", "2026-09-28T14:00:00Z"),
        tool("list_charges", "2026-09-27T09:00:00Z"),
      ],
      ["create_refund"],
    );

    const result = await readServerTools(ACTOR, "stripe", { tools });

    expect(result.tools).toEqual([
      { ...tool("create_refund", "2026-09-28T14:00:00Z"), withheld: true },
      { ...tool("list_charges", "2026-09-27T09:00:00Z"), withheld: false },
    ]);
  });

  it("names the newest snapshot row and when it was written", async () => {
    const tools = toolsDouble([
      tool("create_refund", "2026-09-27T09:00:00Z", "snap_old"),
      tool("list_charges", "2026-09-28T14:00:00Z", "snap_new"),
      tool("void_invoice", "2026-09-26T09:00:00Z", "snap_oldest"),
    ]);

    const result = await readServerTools(ACTOR, "stripe", { tools });

    expect(result.snapshotId).toBe("snap_new");
    expect(result.capturedAt).toEqual(new Date("2026-09-28T14:00:00Z"));
  });

  it("answers not found for a name that cannot be a server folder", async () => {
    const tools = toolsDouble([]);

    await expect(
      readServerTools(ACTOR, "../Stripe", { tools }),
    ).rejects.toMatchObject({ code: "not_found", reason: "mcp_server_not_found" });
    expect(tools.read).not.toHaveBeenCalled();
  });
});

describe("readServerDiscovery and listServerDiscoveries", () => {
  it("reads one server's row for a Viewer", async () => {
    const store = storeDouble(row("stripe"));

    await expect(readServerDiscovery(ACTOR, "stripe", { store })).resolves.toEqual(
      row("stripe"),
    );
    expect(roleGate.assertOrgRole).toHaveBeenCalledWith(
      expect.anything(),
      READ_ROLES,
    );
    expect(store.read).toHaveBeenCalledWith(SCOPE, "stripe");
  });

  it("refuses a non-member before it reads", async () => {
    roleGate.refuse = true;
    const store = storeDouble(row("stripe"));

    await expect(listServerDiscoveries(ACTOR, { store })).rejects.toThrow(
      /forbidden/,
    );
    expect(store.list).not.toHaveBeenCalled();
  });

  it("lists every discovered server in the workspace", async () => {
    const store = storeDouble(row("stripe"));

    await expect(listServerDiscoveries(ACTOR, { store })).resolves.toEqual([
      row("stripe"),
    ]);
    expect(store.list).toHaveBeenCalledWith(SCOPE);
  });
});

describe("startServerDiscovery", () => {
  it("checks the editing roles, queues the server, and sends one event", async () => {
    const store = storeDouble(row("stripe"));
    const send = vi.fn(async () => {});

    const result = await startServerDiscovery(ACTOR, "stripe", {
      store,
      send,
      now: () => NOW,
    });

    expect(roleGate.assertOrgRole).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS, userId: "user_1" },
      START_ROLES,
    );
    expect(store.request).toHaveBeenCalledWith(
      SCOPE,
      "stripe",
      "manual",
      "user_1",
      NOW,
    );
    expect(send).toHaveBeenCalledWith([
      {
        name: "mcp-server/discover.requested",
        data: {
          orgId: ORG,
          workspaceId: WS,
          server: "stripe",
          trigger: "manual",
          key: `${ORG}:${WS}:stripe`,
          requestedBy: "user_1",
        },
      },
    ]);
    expect(result).toEqual(row("stripe"));
  });

  it("queues nothing for a caller who may not edit tools", async () => {
    roleGate.refuse = true;
    const store = storeDouble();
    const send = vi.fn(async () => {});

    await expect(
      startServerDiscovery(ACTOR, "stripe", { store, send }),
    ).rejects.toThrow(/forbidden/);
    expect(store.request).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("requestDiscoveries", () => {
  it("queues each target and sends one event per target, with no role check", async () => {
    const store = storeDouble();
    const send = vi.fn(async () => {});
    const other = { orgId: ORG, workspaceId: "ws_other" };

    const count = await requestDiscoveries(
      [
        { scope: SCOPE, server: "stripe" },
        { scope: other, server: "github" },
      ],
      "push",
      { store, send, now: () => NOW },
    );

    expect(count).toBe(2);
    expect(roleGate.assertOrgRole).not.toHaveBeenCalled();
    expect(store.request).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith([
      expect.objectContaining({
        data: expect.objectContaining({ server: "stripe", trigger: "push" }),
      }),
      expect.objectContaining({
        data: expect.objectContaining({
          server: "github",
          key: `${ORG}:ws_other:github`,
        }),
      }),
    ]);
  });

  it("refuses a bad name before it queues anything", async () => {
    const store = storeDouble();
    const send = vi.fn(async () => {});

    await expect(
      requestDiscoveries([{ scope: SCOPE, server: "Not A Folder" }], "push", {
        store,
        send,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(store.request).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("sends through the event client by default, and skips an empty batch", async () => {
    const store = storeDouble();

    await requestDiscovery(SCOPE, "stripe", "list_changed", { store });
    await requestDiscoveries([], "schedule", { store });

    expect(events.send).toHaveBeenCalledTimes(1);
    expect(events.send).toHaveBeenCalledWith([
      {
        name: "mcp-server/discover.requested",
        data: {
          orgId: ORG,
          workspaceId: WS,
          server: "stripe",
          trigger: "list_changed",
          key: `${ORG}:${WS}:stripe`,
        },
      },
    ]);
  });
});

describe("runDiscoveryEvent", () => {
  const data = {
    orgId: ORG,
    workspaceId: WS,
    server: "stripe",
    trigger: "schedule",
  };

  it("runs the discovery in the workspace's scope", async () => {
    run.runDiscovery.mockResolvedValueOnce({ server: "stripe" });

    await expect(runDiscoveryEvent({ ...data, requestedBy: "user_1" })).resolves.toEqual(
      { server: "stripe" },
    );
    expect(tenancy.scopes).toEqual([SCOPE]);
    expect(run.runDiscovery).toHaveBeenCalledWith(
      { scope: SCOPE, server: "stripe", trigger: "schedule", requestedBy: "user_1" },
      {},
    );
  });

  it("marks an unknown trigger as not worth a retry", async () => {
    await expect(
      runDiscoveryEvent({ ...data, trigger: "sometimes" }),
    ).rejects.toMatchObject({ isNonRetriable: true });
    expect(run.runDiscovery).not.toHaveBeenCalled();
  });

  it("marks a bad server name as not worth a retry", async () => {
    await expect(
      runDiscoveryEvent({ ...data, server: "Bad-Name" }),
    ).rejects.toMatchObject({ isNonRetriable: true });
    expect(run.runDiscovery).not.toHaveBeenCalled();
  });
});

describe("planDiscoverySweep", () => {
  it("asks once per server and trigger, with an id for the hour", async () => {
    const other = { orgId: ORG, workspaceId: "ws_other" };
    const sweep = {
      undiscovered: vi.fn(async () => [{ scope: SCOPE, server: "stripe" }]),
      dueDaily: vi.fn(async () => [
        { scope: SCOPE, server: "stripe" },
        { scope: other, server: "github" },
        { scope: SCOPE, server: "Bad Name" },
      ]),
      openPullRequests: vi.fn(async () => [{ scope: SCOPE, server: "stripe" }]),
      stalled: vi.fn(async () => []),
      registryMoved: vi.fn(async () => []),
      onChangeByRepo: vi.fn(async () => []),
    };

    const planned = await planDiscoverySweep(NOW, { sweep });

    expect(sweep.undiscovered).toHaveBeenCalledWith(SWEEP_LIMIT);
    expect(sweep.dueDaily).toHaveBeenCalledWith(
      new Date(NOW.getTime() - DAILY_MS),
      SWEEP_LIMIT,
    );
    expect(planned.map((e) => [e.data.server, e.data.trigger, e.id])).toEqual([
      ["stripe", "schedule", `mcp-discovery:schedule:${ORG}:${WS}:stripe:2026-09-28T15`],
      [
        "github",
        "schedule",
        `mcp-discovery:schedule:${ORG}:ws_other:github:2026-09-28T15`,
      ],
      [
        "stripe",
        "lock_merged",
        `mcp-discovery:lock_merged:${ORG}:${WS}:stripe:2026-09-28T15`,
      ],
    ]);
  });

  it("asks again for a stalled discovery, with the trigger it had", async () => {
    const sweep = {
      undiscovered: vi.fn(async () => []),
      dueDaily: vi.fn(async () => []),
      openPullRequests: vi.fn(async () => []),
      stalled: vi.fn(async () => [
        { scope: SCOPE, server: "stripe", trigger: "push" as const },
        { scope: SCOPE, server: "github", trigger: "manual" as const },
        { scope: SCOPE, server: "Bad Name", trigger: "push" as const },
      ]),
      registryMoved: vi.fn(async () => []),
      onChangeByRepo: vi.fn(async () => []),
    };

    const planned = await planDiscoverySweep(NOW, { sweep });

    expect(sweep.stalled).toHaveBeenCalledWith(
      new Date(NOW.getTime() - STALLED_MS),
      SWEEP_LIMIT,
    );
    expect(planned.map((e) => [e.data.server, e.data.trigger, e.id])).toEqual([
      ["stripe", "push", `mcp-discovery:push:${ORG}:${WS}:stripe:2026-09-28T15`],
      [
        "github",
        "manual",
        `mcp-discovery:manual:${ORG}:${WS}:github:2026-09-28T15`,
      ],
    ]);
  });

  it("asks for a registry_version discovery when the catalog lists a newer version", async () => {
    const other = { orgId: ORG, workspaceId: "ws_other" };
    const sweep = {
      undiscovered: vi.fn(async () => []),
      dueDaily: vi.fn(async () => []),
      openPullRequests: vi.fn(async () => []),
      stalled: vi.fn(async () => []),
      registryMoved: vi.fn(async () => [
        { scope: SCOPE, server: "github" },
        { scope: other, server: "github" },
        { scope: SCOPE, server: "Bad Name" },
      ]),
      onChangeByRepo: vi.fn(async () => []),
    };

    const planned = await planDiscoverySweep(NOW, { sweep });

    expect(sweep.registryMoved).toHaveBeenCalledWith(SWEEP_LIMIT);
    expect(planned.map((e) => [e.data.server, e.data.trigger, e.id])).toEqual([
      [
        "github",
        "registry_version",
        `mcp-discovery:registry_version:${ORG}:${WS}:github:2026-09-28T15`,
      ],
      [
        "github",
        "registry_version",
        `mcp-discovery:registry_version:${ORG}:ws_other:github:2026-09-28T15`,
      ],
    ]);
  });

  it("sends no registry_version event for a server already scheduled this hour", async () => {
    const sweep = {
      undiscovered: vi.fn(async () => [{ scope: SCOPE, server: "github" }]),
      dueDaily: vi.fn(async () => [{ scope: SCOPE, server: "linear" }]),
      openPullRequests: vi.fn(async () => [{ scope: SCOPE, server: "notion" }]),
      stalled: vi.fn(async () => []),
      registryMoved: vi.fn(async () => [
        { scope: SCOPE, server: "github" },
        { scope: SCOPE, server: "linear" },
        { scope: SCOPE, server: "notion" },
      ]),
      onChangeByRepo: vi.fn(async () => []),
    };

    const planned = await planDiscoverySweep(NOW, { sweep });

    // A scheduled discovery reads the registry's newest version itself, so
    // github and linear get one event each. lock_merged reads no registry,
    // so notion keeps its registry_version event.
    expect(planned.map((e) => [e.data.server, e.data.trigger])).toEqual([
      ["github", "schedule"],
      ["linear", "schedule"],
      ["notion", "lock_merged"],
      ["notion", "registry_version"],
    ]);
  });
});
