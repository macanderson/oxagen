// discovery.get.test.ts: get_studio_discovery (lane M10, #4682). The role
// gate, the tenant scope, and the store are doubles, so each case checks what
// the handler reads and what it returns.
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
    return "Viewer";
  }),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));

vi.mock("../../event-client", () => ({ eventClient: { send: vi.fn() } }));

import { createGetStudioDiscoveryHandler } from "./discovery.get";
import { STALLED_MS } from "./entry";

const ORG = "0191d0a0-0000-7000-8000-000000000001";
const WS = "0191d0a0-0000-7000-8000-000000000002";
const SCOPE = { orgId: ORG, workspaceId: WS };
const CTX = makeCTX({ orgId: ORG, workspaceId: WS, userId: "user_1" });
const NOW = new Date("2026-09-28T15:00:12Z");

const READ_ROLES = {
  org: ["Owner", "Admin"],
  workspace: ["Owner", "Member", "Viewer"],
};

function row(overrides: Partial<DiscoveryRow> = {}): DiscoveryRow {
  return {
    id: "0191d0a0-0000-7000-8000-00000000d15c",
    server: "stripe",
    mcpServerId: "mcs_1",
    status: "succeeded",
    trigger: "manual",
    requestedAt: NOW,
    requestedBy: "user_1",
    startedAt: NOW,
    finishedAt: NOW,
    error: null,
    outcome: "pr_opened",
    toolCount: 3,
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

describe("get_studio_discovery", () => {
  it("lets a workspace Viewer read the server's discovery", async () => {
    const store = storeDouble(row());
    const handler = createGetStudioDiscoveryHandler({ store, now: () => NOW });

    const out = await handler({ server: "stripe" }, CTX);

    expect(roleGate.assertOrgRole).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WS, userId: "user_1" },
      READ_ROLES,
    );
    expect(store.read).toHaveBeenCalledWith(SCOPE, "stripe");
    expect(out.discovery).toMatchObject({
      server: "stripe",
      mcpServerId: "mcs_1",
      status: "succeeded",
      outcome: "pr_opened",
      toolCount: 3,
      finishedAt: NOW.toISOString(),
      stalled: false,
    });
  });

  it("answers null for a server never discovered", async () => {
    const handler = createGetStudioDiscoveryHandler({
      store: storeDouble(null),
      now: () => NOW,
    });

    await expect(handler({ server: "stripe" }, CTX)).resolves.toEqual({
      discovery: null,
    });
  });

  it("reads stalled from the clock it is given", async () => {
    const old = new Date(NOW.getTime() - STALLED_MS - 60_000);
    const fresh = new Date(NOW.getTime() - STALLED_MS + 60_000);
    const queued = (requestedAt: Date) =>
      row({
        status: "queued",
        requestedAt,
        startedAt: null,
        finishedAt: null,
        outcome: null,
      });

    const stale = createGetStudioDiscoveryHandler({
      store: storeDouble(queued(old)),
      now: () => NOW,
    });
    const recent = createGetStudioDiscoveryHandler({
      store: storeDouble(queued(fresh)),
      now: () => NOW,
    });

    expect((await stale({ server: "stripe" }, CTX)).discovery?.stalled).toBe(
      true,
    );
    expect((await recent({ server: "stripe" }, CTX)).discovery?.stalled).toBe(
      false,
    );
  });

  it("refuses a caller outside the workspace before it reads", async () => {
    roleGate.refuse = true;
    const store = storeDouble(row());
    const handler = createGetStudioDiscoveryHandler({ store });

    await expect(handler({ server: "stripe" }, CTX)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(store.read).not.toHaveBeenCalled();
  });

  it("answers not found for a name that cannot be a server folder", async () => {
    const store = storeDouble(row());
    const handler = createGetStudioDiscoveryHandler({ store });

    await expect(handler({ server: "../Stripe" }, CTX)).rejects.toMatchObject({
      code: "not_found",
      reason: "mcp_server_not_found",
    });
    expect(store.read).not.toHaveBeenCalled();
  });
});
