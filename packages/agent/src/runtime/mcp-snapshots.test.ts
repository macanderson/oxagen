import { describe, expect, it, vi, beforeEach } from "vitest";

// ── @oxagen/database mock ────────────────────────────────────────────────────
const state = vi.hoisted(() => ({
  selectRows: [] as unknown[],
  insertedValues: [] as unknown[],
}));

// insert→values resolves (snapshot capture + audit are fire-and-forget inserts).
const valuesMock = vi.fn(async (v: unknown) => {
  state.insertedValues.push(v);
  return undefined;
});
const insertMock = vi.fn(() => ({ values: valuesMock }));

const orderByMock = vi.fn(async () => state.selectRows);
const whereMock = vi.fn(() => ({ orderBy: orderByMock }));
const fromMock = vi.fn(() => ({ where: whereMock }));
const selectMock = vi.fn(() => ({ from: fromMock }));

const fakeDb = { insert: insertMock, select: selectMock };

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => fakeDb,
    withTenantDb: async (fn: (tx: typeof fakeDb) => Promise<unknown>) => fn(fakeDb),
    schema: {
      mcpToolSnapshots: {
        orgId: "ts.orgId",
        workspaceId: "ts.workspaceId",
        mcpServerId: "ts.mcpServerId",
        toolName: "ts.toolName",
        schemaJson: "ts.schemaJson",
        capturedAt: "ts.capturedAt",
      },
      mcpServerChanges: {
        orgId: "sc.orgId",
        workspaceId: "sc.workspaceId",
        serverId: "sc.serverId",
        changeType: "sc.changeType",
        actorUserId: "sc.actorUserId",
      },
    },
  };
});

import {
  captureToolSnapshots,
  readLatestSnapshots,
  recordServerChange,
} from "./mcp-snapshots";
import type { McpToolDescriptor } from "../dispatch/mcp-client";

const DESCRIPTORS: McpToolDescriptor[] = [
  { name: "list_prs", description: "List PRs", inputSchema: { type: "object" } },
  { name: "get_pr", description: null, inputSchema: { type: "object", required: ["id"] } },
];

describe("mcp-snapshots — captureToolSnapshots", () => {
  beforeEach(() => {
    state.insertedValues.length = 0;
    valuesMock.mockClear();
    insertMock.mockClear();
  });

  it("writes one row per descriptor and returns the count", async () => {
    const n = await captureToolSnapshots({
      orgId: "ten_1",
      workspaceId: "ws_1",
      mcpServerId: "srv_1",
      descriptors: DESCRIPTORS,
    });
    expect(n).toBe(2);
    const rows = state.insertedValues[0] as Array<{ toolName: string; schemaJson: unknown }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.toolName).toBe("list_prs");
    // Snapshot embeds name + description + inputSchema for replay fidelity.
    expect(rows[0]!.schemaJson).toEqual({
      name: "list_prs",
      description: "List PRs",
      inputSchema: { type: "object" },
    });
  });

  it("is a no-op for an empty descriptor list", async () => {
    const n = await captureToolSnapshots({
      orgId: "ten_1",
      workspaceId: "ws_1",
      mcpServerId: "srv_1",
      descriptors: [],
    });
    expect(n).toBe(0);
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe("mcp-snapshots — readLatestSnapshots", () => {
  beforeEach(() => {
    state.selectRows = [];
    orderByMock.mockClear();
  });

  it("collapses to the newest snapshot per tool name", async () => {
    const newer = new Date("2026-06-19T00:00:00.000Z");
    const older = new Date("2026-06-01T00:00:00.000Z");
    // Rows arrive ordered newest-first (the query orders by captured_at desc).
    state.selectRows = [
      { toolName: "list_prs", schemaJson: { v: 2 }, capturedAt: newer },
      { toolName: "list_prs", schemaJson: { v: 1 }, capturedAt: older },
      { toolName: "get_pr", schemaJson: { v: 1 }, capturedAt: older },
    ];
    const rows = await readLatestSnapshots("ten_1", "ws_1", "srv_1");
    expect(rows).toHaveLength(2);
    const listPrs = rows.find((r) => r.toolName === "list_prs");
    expect(listPrs!.schemaJson).toEqual({ v: 2 });
    expect(listPrs!.capturedAt).toBe("2026-06-19T00:00:00.000Z");
  });
});

describe("mcp-snapshots — recordServerChange", () => {
  beforeEach(() => {
    state.insertedValues.length = 0;
    valuesMock.mockClear();
  });

  it("appends an audit row with the change type and actor", async () => {
    await recordServerChange({
      orgId: "ten_1",
      workspaceId: "ws_1",
      serverId: "srv_1",
      changeType: "delete",
      actorUserId: "u_1",
    });
    const v = state.insertedValues[0] as {
      changeType: string;
      serverId: string;
      actorUserId: string | null;
    };
    expect(v.changeType).toBe("delete");
    expect(v.serverId).toBe("srv_1");
    expect(v.actorUserId).toBe("u_1");
  });

  it("defaults actorUserId to null for system-driven changes", async () => {
    await recordServerChange({
      orgId: "ten_1",
      workspaceId: "ws_1",
      serverId: "srv_1",
      changeType: "enable",
    });
    const v = state.insertedValues[0] as { actorUserId: string | null };
    expect(v.actorUserId).toBeNull();
  });
});
