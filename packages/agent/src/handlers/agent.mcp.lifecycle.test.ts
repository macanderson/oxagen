import { describe, expect, it, vi, beforeEach } from "vitest";

// ── @oxagen/database mock ────────────────────────────────────────────────────
// set_enabled: select→from→where→limit (resolve server), then update→set→where.
// delete: update→set→where→returning.
const state = vi.hoisted(() => ({
  selectRows: [
    {
      id: "mcs_uuid_1",
      transportType: "streamable-http",
      endpointUrl: "https://mcp.example.com",
      authStrategy: "none",
      authConfig: {},
    },
  ] as unknown[],
  updateReturning: [{ id: "mcs_uuid_1" }] as unknown[],
}));

const limitMock = vi.fn(async () => state.selectRows);
const selectWhereMock = vi.fn(() => ({ limit: limitMock }));
const fromMock = vi.fn(() => ({ where: selectWhereMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

const updateReturningMock = vi.fn(async () => state.updateReturning);
// update→set→where is awaited directly in set_enabled, but chained with
// returning in delete. Return a thenable that also exposes returning().
const updateWhereMock = vi.fn(() => {
  const p = Promise.resolve(undefined) as Promise<unknown> & {
    returning: typeof updateReturningMock;
  };
  p.returning = updateReturningMock;
  return p;
});
const setMock = vi.fn(() => ({ where: updateWhereMock }));
const updateMock = vi.fn(() => ({ set: setMock }));

const fakeDb = { select: selectMock, update: updateMock };

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => fakeDb,
    withTenantDb: async (fn: (tx: typeof fakeDb) => Promise<unknown>) =>
      fn(fakeDb),
    schema: {
      mcpServers: {
        id: "m.id",
        publicId: "m.publicId",
        orgId: "m.orgId",
        workspaceId: "m.workspaceId",
        deletedAt: "m.deletedAt",
        deletedByUserId: "m.deletedByUserId",
        enabled: "m.enabled",
        healthStatus: "m.healthStatus",
        lastHealthcheckAt: "m.lastHealthcheckAt",
        transportType: "m.transportType",
        endpointUrl: "m.endpointUrl",
        authStrategy: "m.authStrategy",
        authConfig: "m.authConfig",
        updatedAt: "m.updatedAt",
        updatedByUserId: "m.updatedByUserId",
      },
    },
  };
});

const depMocks = vi.hoisted(() => ({
  healthcheck: vi.fn(async () => ({
    status: "healthy" as const,
    discoveredTools: ["tool_a"],
    descriptors: [{ name: "tool_a", description: null, inputSchema: {} }],
  })),
  captureToolSnapshots: vi.fn(async () => 1),
  recordServerChange: vi.fn(async () => undefined),
}));
vi.mock("../dispatch/mcp-client", () => ({
  healthcheck: depMocks.healthcheck,
}));
vi.mock("../runtime/mcp-snapshots", () => ({
  captureToolSnapshots: depMocks.captureToolSnapshots,
  recordServerChange: depMocks.recordServerChange,
}));

// Capture the module-level pino logger so the snapshot-failure path can be
// asserted (the enable must proceed with a 0 baseline AND log a warning).
const loggerMock = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("pino", () => ({ default: () => loggerMock }));

import { agentMcpSetEnabledHandler } from "./agent.mcp.set_enabled";
import { agentMcpDeleteHandler } from "./agent.mcp.delete";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

describe("agent.mcp.set_enabled handler", () => {
  beforeEach(() => {
    state.selectRows = [
      {
        id: "mcs_uuid_1",
        transportType: "streamable-http",
        endpointUrl: "https://mcp.example.com",
        authStrategy: "none",
        authConfig: {},
      },
    ];
    selectMock.mockClear();
    updateMock.mockClear();
    depMocks.healthcheck.mockClear();
    depMocks.captureToolSnapshots.mockClear();
    depMocks.captureToolSnapshots.mockResolvedValue(1);
    depMocks.recordServerChange.mockClear();
    loggerMock.warn.mockClear();
  });

  it("re-enabling re-probes, re-captures snapshots, and audits an 'enable'", async () => {
    const out = await agentMcpSetEnabledHandler(
      { mcpServerId: "mcs_pub_1", enabled: true },
      CTX,
    );
    expect(out).toEqual({
      mcpServerId: "mcs_pub_1",
      enabled: true,
      snapshotCount: 1,
    });
    expect(depMocks.healthcheck).toHaveBeenCalledTimes(1);
    expect(depMocks.captureToolSnapshots).toHaveBeenCalledTimes(1);
    expect(depMocks.recordServerChange).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "mcs_uuid_1", changeType: "enable" }),
    );
  });

  it("disabling skips the probe and audits a 'disable'", async () => {
    const out = await agentMcpSetEnabledHandler(
      { mcpServerId: "mcs_pub_1", enabled: false },
      CTX,
    );
    expect(out.enabled).toBe(false);
    expect(out.snapshotCount).toBe(0);
    expect(depMocks.healthcheck).not.toHaveBeenCalled();
    expect(depMocks.captureToolSnapshots).not.toHaveBeenCalled();
    expect(depMocks.recordServerChange).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "mcs_uuid_1",
        changeType: "disable",
      }),
    );
  });

  it("logs a warning and enables with a 0 baseline when snapshot capture fails", async () => {
    depMocks.captureToolSnapshots.mockRejectedValueOnce(
      new Error("neo4j down"),
    );
    const out = await agentMcpSetEnabledHandler(
      { mcpServerId: "mcs_pub_1", enabled: true },
      CTX,
    );
    // Enable still proceeds — best-effort fallback keeps the count at 0.
    expect(out).toEqual({
      mcpServerId: "mcs_pub_1",
      enabled: true,
      snapshotCount: 0,
    });
    expect(depMocks.recordServerChange).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "mcs_uuid_1", changeType: "enable" }),
    );
    // The dropped baseline is surfaced with server context, not swallowed.
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mcpServerId: "mcs_uuid_1" }),
      expect.stringContaining("tool snapshot failed"),
    );
  });

  it("throws when the server is not found (or already deleted)", async () => {
    state.selectRows = [];
    await expect(
      agentMcpSetEnabledHandler({ mcpServerId: "missing", enabled: true }, CTX),
    ).rejects.toThrow("mcp server not found");
  });
});

describe("agent.mcp.delete handler", () => {
  beforeEach(() => {
    state.updateReturning = [{ id: "mcs_uuid_1" }];
    updateMock.mockClear();
    updateReturningMock.mockClear();
    depMocks.recordServerChange.mockClear();
  });

  it("soft-deletes, then audits a 'delete'", async () => {
    const out = await agentMcpDeleteHandler({ mcpServerId: "mcs_pub_1" }, CTX);
    expect(out).toEqual({ mcpServerId: "mcs_pub_1", deleted: true });
    expect(depMocks.recordServerChange).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: "mcs_uuid_1", changeType: "delete" }),
    );
  });

  it("is an idempotent no-op when already deleted / not found", async () => {
    state.updateReturning = [];
    const out = await agentMcpDeleteHandler({ mcpServerId: "mcs_pub_1" }, CTX);
    expect(out).toEqual({ mcpServerId: "mcs_pub_1", deleted: false });
    expect(depMocks.recordServerChange).not.toHaveBeenCalled();
  });
});
