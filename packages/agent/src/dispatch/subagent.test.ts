import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  txInsertCalls: [] as Array<{ table: string; values: unknown }>,
  fanoutRow: { id: "fan_123", tenantId: "ten_1", status: "pending" },
  runsRows: [] as Array<Record<string, unknown>>,
  inngestSend: vi.fn(async () => undefined),
  limitFanout: vi.fn(),
}));

mocks.limitFanout.mockImplementation(async () => [mocks.fanoutRow]);

const fakeTx = {
  insert: (table: { _name?: string }) => {
    const tableName = table._name ?? "unknown";
    return {
      values: (v: unknown) => {
        mocks.txInsertCalls.push({ table: tableName, values: v });
        return {
          returning: async () => [{ id: "fan_123" }],
          then: (resolve: (x: unknown) => void) => resolve(undefined),
        };
      },
    };
  },
};

vi.mock("@oxagen/database", () => ({
  db: () => ({
    transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx),
    select: () => ({
      from: (tbl: { _name: string }) => {
        if (tbl._name === "subagentRuns") {
          return { where: async () => mocks.runsRows };
        }
        return { where: () => ({ limit: mocks.limitFanout }) };
      },
    }),
  }),
  schema: {
    subagentFanouts: { _name: "subagentFanouts", id: "id", tenantId: "tenantId" },
    subagentRuns: { _name: "subagentRuns", fanoutId: "fanoutId" },
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ _and: args }),
  eq: (col: unknown, val: unknown) => ({ _eq: [col, val] }),
}));

vi.mock("inngest", () => ({
  Inngest: vi.fn(() => ({ send: mocks.inngestSend })),
}));

vi.mock("@oxagen/config/env", () => ({
  loadEnv: () => ({ INNGEST_EVENT_KEY: "test" }),
}));

import { dispatchFanout, readFanout } from "./subagent.js";

describe("subagent dispatch", () => {
  beforeEach(() => {
    mocks.txInsertCalls.length = 0;
    mocks.inngestSend.mockClear();
    mocks.runsRows = [];
    mocks.limitFanout.mockImplementation(async () => [mocks.fanoutRow]);
  });

  it("dispatchFanout inserts fanout + child rows in one batch and sends Inngest event", async () => {
    const res = await dispatchFanout({
      tenantId: "ten_1",
      workspaceId: "ws_1",
      parentMessageId: "msg_parent",
      children: [
        { capability: "agent.memory.recall", input: { q: "a" } },
        { capability: "agent.memory.recall", input: { q: "b" } },
        { capability: "agent.memory.recall", input: { q: "c" } },
      ],
    });

    expect(res.fanoutId).toBe("fan_123");
    expect(res.childMessageIds).toHaveLength(3);

    // Exactly 2 inserts: one fanout row + one batched runs insert.
    expect(mocks.txInsertCalls).toHaveLength(2);
    expect(mocks.txInsertCalls[0]!.table).toBe("subagentFanouts");
    expect(mocks.txInsertCalls[1]!.table).toBe("subagentRuns");
    expect(Array.isArray(mocks.txInsertCalls[1]!.values)).toBe(true);
    expect((mocks.txInsertCalls[1]!.values as unknown[]).length).toBe(3);

    expect(mocks.inngestSend).toHaveBeenCalledTimes(1);
    const calls = mocks.inngestSend.mock.calls as unknown as Array<[{ name: string; data: Record<string, unknown> }]>;
    const evt = calls[0]![0];
    expect(evt.name).toBe("agent/subagent.dispatch");
    expect(evt.data.fanoutId).toBe("fan_123");
    expect(evt.data.tenantId).toBe("ten_1");
  });

  it("readFanout returns current state when fanout exists", async () => {
    mocks.runsRows = [
      {
        childMessageId: "c1",
        capabilityName: "agent.memory.recall",
        status: "completed",
        outputPayload: { result: 1 },
        errorReason: null,
      },
    ];
    const snap = await readFanout("fan_123", "ten_1");
    expect(snap).not.toBeNull();
    expect(snap!.fanoutId).toBe("fan_123");
    expect(snap!.status).toBe("pending");
    expect(snap!.results).toHaveLength(1);
    expect(snap!.results[0]!.childMessageId).toBe("c1");
    expect(snap!.results[0]!.capability).toBe("agent.memory.recall");
    expect(snap!.results[0]!.status).toBe("completed");
  });

  it("readFanout returns null when fanout row is absent", async () => {
    mocks.limitFanout.mockImplementationOnce(async () => []);
    const snap = await readFanout("missing", "ten_1");
    expect(snap).toBeNull();
  });
});
