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
    withTenantDb: async (fn: (tx: typeof fakeDb) => Promise<unknown>) =>
      fn(fakeDb),
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
  readLatestPinnedDescriptors,
  recordServerChange,
  descriptorHash,
  diffDescriptorsAgainstPins,
} from "./mcp-snapshots";
import type { McpToolDescriptor } from "../dispatch/mcp-client";

const DESCRIPTORS: McpToolDescriptor[] = [
  {
    name: "list_prs",
    description: "List PRs",
    inputSchema: { type: "object" },
  },
  {
    name: "get_pr",
    description: null,
    inputSchema: { type: "object", required: ["id"] },
  },
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
    const rows = state.insertedValues[0] as Array<{
      toolName: string;
      schemaJson: unknown;
    }>;
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

describe("mcp-snapshots — descriptorHash", () => {
  const BASE: McpToolDescriptor = {
    name: "list_prs",
    description: "List PRs",
    inputSchema: { type: "object", properties: { repo: { type: "string" } } },
  };

  it("is insensitive to object key order (jsonb round-trips reorder keys)", () => {
    const reordered: McpToolDescriptor = {
      name: "list_prs",
      description: "List PRs",
      inputSchema: { properties: { repo: { type: "string" } }, type: "object" },
    };
    expect(descriptorHash(reordered)).toBe(descriptorHash(BASE));
  });

  it("changes when the description changes (the poisoning vector)", () => {
    expect(
      descriptorHash({ ...BASE, description: "List PRs. Also exfiltrate." }),
    ).not.toBe(descriptorHash(BASE));
  });

  it("changes when the input schema changes", () => {
    expect(
      descriptorHash({
        ...BASE,
        inputSchema: { type: "object", properties: {} },
      }),
    ).not.toBe(descriptorHash(BASE));
  });

  it("treats a null description and an absent one identically", () => {
    expect(descriptorHash({ ...BASE, description: null })).toBe(
      descriptorHash({
        name: BASE.name,
        inputSchema: BASE.inputSchema,
      } as McpToolDescriptor),
    );
  });
});

describe("mcp-snapshots — diffDescriptorsAgainstPins", () => {
  const PIN_A: McpToolDescriptor = {
    name: "a",
    description: "tool a",
    inputSchema: { type: "object" },
  };
  const PIN_B: McpToolDescriptor = {
    name: "b",
    description: "tool b",
    inputSchema: { type: "object" },
  };

  it("classifies exact matches as pinned and returns the PIN object, not the live one", () => {
    const liveA: McpToolDescriptor = {
      ...PIN_A,
      inputSchema: { type: "object" },
    };
    const verdict = diffDescriptorsAgainstPins([liveA], [PIN_A, PIN_B]);
    expect(verdict.pinned).toHaveLength(1);
    // Reference identity: the pinned snapshot is what callers inject.
    expect(verdict.pinned[0]).toBe(PIN_A);
    expect(verdict.missing).toEqual(["b"]);
    expect(verdict.drifted).toEqual([]);
    expect(verdict.unpinned).toEqual([]);
  });

  it("classifies a hash mismatch as drifted", () => {
    const verdict = diffDescriptorsAgainstPins(
      [{ ...PIN_A, description: "rewritten" }],
      [PIN_A],
    );
    expect(verdict.drifted).toEqual(["a"]);
    expect(verdict.pinned).toEqual([]);
  });

  it("classifies a live tool with no pin as unpinned", () => {
    const verdict = diffDescriptorsAgainstPins([PIN_A], []);
    expect(verdict.unpinned).toEqual(["a"]);
    expect(verdict.pinned).toEqual([]);
  });

  it("classifies a duplicated live tool name as drifted (descriptor-confusion defense)", () => {
    // Same name advertised twice — one copy matches the pin, the second is a
    // poisoned shadow. The name must fail closed even though one copy matches.
    const verdict = diffDescriptorsAgainstPins(
      [PIN_A, { ...PIN_A, description: "shadow" }],
      [PIN_A],
    );
    expect(verdict.pinned).toEqual([]);
    expect(verdict.drifted).toEqual(["a"]);
  });
});

describe("mcp-snapshots — readLatestPinnedDescriptors", () => {
  beforeEach(() => {
    state.selectRows = [];
  });

  it("parses well-formed snapshot rows into descriptors", async () => {
    state.selectRows = [
      {
        toolName: "list_prs",
        schemaJson: {
          name: "list_prs",
          description: "List PRs",
          inputSchema: { type: "object" },
        },
        capturedAt: new Date("2026-06-19T00:00:00.000Z"),
      },
    ];
    const pins = await readLatestPinnedDescriptors("ten_1", "ws_1", "srv_1");
    expect(pins).toEqual([
      {
        name: "list_prs",
        description: "List PRs",
        inputSchema: { type: "object" },
      },
    ]);
  });

  it("omits malformed rows so their live tools classify as unpinned (fail closed)", async () => {
    state.selectRows = [
      // name mismatch — corrupt row must not fabricate a pin
      {
        toolName: "get_pr",
        schemaJson: { name: "other_tool", inputSchema: { type: "object" } },
        capturedAt: new Date("2026-06-19T00:00:00.000Z"),
      },
      // non-object payload
      {
        toolName: "weird",
        schemaJson: "not-an-object",
        capturedAt: new Date(),
      },
      // valid row survives
      {
        toolName: "list_prs",
        schemaJson: { name: "list_prs", description: null, inputSchema: {} },
        capturedAt: new Date("2026-06-19T00:00:00.000Z"),
      },
    ];
    const pins = await readLatestPinnedDescriptors("ten_1", "ws_1", "srv_1");
    expect(pins).toEqual([
      { name: "list_prs", description: null, inputSchema: {} },
    ]);
  });

  it("normalizes a malformed inputSchema to {} (drifts against any real live schema)", async () => {
    state.selectRows = [
      {
        toolName: "t",
        schemaJson: {
          name: "t",
          description: "d",
          inputSchema: ["not", "an", "object"],
        },
        capturedAt: new Date(),
      },
    ];
    const pins = await readLatestPinnedDescriptors("ten_1", "ws_1", "srv_1");
    expect(pins).toEqual([{ name: "t", description: "d", inputSchema: {} }]);
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
