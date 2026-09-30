// discovery.start.test.ts: start_studio_discovery (lane M10, #4682). The role
// gate, the tenant scope, the store, and the sender are doubles, so each case
// checks what the handler asks for and what it returns.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCTX } from "../../test-utils/fixtures";
import type { DiscoveryRow, DiscoveryStore } from "./store";

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
    return "Member";
  }),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));

vi.mock("../../event-client", () => ({ eventClient: { send: vi.fn() } }));

import {
  createStartStudioDiscoveryHandler,
  discoveryActor,
} from "./discovery.start";
import { STALLED_MS } from "./entry";

const ORG = "0191d0a0-0000-7000-8000-000000000001";
const WS = "0191d0a0-0000-7000-8000-000000000002";
const SCOPE = { orgId: ORG, workspaceId: WS };
const CTX = makeCTX({ orgId: ORG, workspaceId: WS, userId: "user_1" });
const NOW = new Date("2026-09-28T15:00:12Z");

const START_ROLES = {
  org: ["Owner", "Admin"],
  workspace: ["Owner", "Member"],
};

function row(overrides: Partial<DiscoveryRow> = {}): DiscoveryRow {
  return {
    id: "0191d0a0-0000-7000-8000-00000000d15c",
    server: "stripe",
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
    sourcePath: null,
    sourceRepo: null,
    sourceRef: null,
    schedule: null,
    upstreamDigest: null,
    latestVersion: null,
    pr: null,
    withheld: [],
    ...overrides,
  };
}

function storeDouble(read: DiscoveryRow | null) {
  return {
    request: vi.fn(async () => {}),
    begin: vi.fn(async () => null),
    recordSource: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    read: vi.fn(async () => read),
    list: vi.fn(async () => (read === null ? [] : [read])),
    steeringServerId: vi.fn(async () => null),
    captureSnapshots: vi.fn(async () => 0),
  } satisfies DiscoveryStore;
}

beforeEach(() => {
  roleGate.refuse = false;
  roleGate.assertOrgRole.mockClear();
});

describe("discoveryActor", () => {
  it("reads the caller's org, workspace, user, and API key", () => {
    const ctx = makeCTX({
      orgId: ORG,
      workspaceId: WS,
      userId: null,
      apiKeyId: "key_1",
    });
    expect(discoveryActor(ctx)).toEqual({
      orgId: ORG,
      workspaceId: WS,
      userId: null,
      apiKeyId: "key_1",
    });
  });
});

describe("start_studio_discovery", () => {
  it("queues the server, sends one event, and returns the row as Studio reads it", async () => {
    const store = storeDouble(row());
    const send = vi.fn(async () => {});
    const handler = createStartStudioDiscoveryHandler({
      store,
      send,
      now: () => NOW,
    });

    const out = await handler({ server: "stripe" }, CTX);

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
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.read).toHaveBeenCalledWith(SCOPE, "stripe");
    expect(out.discovery).toMatchObject({
      id: "0191d0a0-0000-7000-8000-00000000d15c",
      server: "stripe",
      status: "queued",
      trigger: "manual",
      requestedAt: NOW.toISOString(),
      requestedBy: "user_1",
      stalled: false,
    });
  });

  it("marks a run stalled by the clock it is given", async () => {
    const started = new Date(NOW.getTime() - STALLED_MS - 60_000);
    const store = storeDouble(
      row({ status: "running", requestedAt: started, startedAt: started }),
    );
    const handler = createStartStudioDiscoveryHandler({
      store,
      send: vi.fn(async () => {}),
      now: () => NOW,
    });

    const out = await handler({ server: "stripe" }, CTX);

    expect(out.discovery).toMatchObject({ status: "running", stalled: true });
  });

  it("throws when the request leaves no row to return", async () => {
    const handler = createStartStudioDiscoveryHandler({
      store: storeDouble(null),
      send: vi.fn(async () => {}),
      now: () => NOW,
    });

    await expect(handler({ server: "stripe" }, CTX)).rejects.toThrow(
      "The discovery request for stripe left no row.",
    );
  });

  it("queues nothing for a caller who may not edit tools", async () => {
    roleGate.refuse = true;
    const store = storeDouble(row());
    const send = vi.fn(async () => {});
    const handler = createStartStudioDiscoveryHandler({ store, send });

    await expect(handler({ server: "stripe" }, CTX)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(store.request).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("answers not found for a name that cannot be a server folder", async () => {
    const store = storeDouble(row());
    const send = vi.fn(async () => {});
    const handler = createStartStudioDiscoveryHandler({ store, send });

    await expect(handler({ server: "../Stripe" }, CTX)).rejects.toMatchObject({
      code: "not_found",
      reason: "mcp_server_not_found",
    });
    expect(store.request).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
