import { describe, expect, it, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  txInsertCalls: [] as Array<{ table: string; values: unknown }>,
  fanoutRow: { id: "fan_123", orgId: "ten_1", status: "pending" },
  runsRows: [] as Array<Record<string, unknown>>,
  inngestSend: vi.fn(async () => undefined),
  limitFanout: vi.fn(),
}));

mocks.limitFanout.mockImplementation(async () => [mocks.fanoutRow]);

const drizzleTableName = (table: unknown): string => {
  try {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  } catch {
    return "unknown";
  }
};

const fakeTx = {
  insert: (table: unknown) => {
    const tableName = drizzleTableName(table);
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

// readFanout uses a tx with .select(); dispatchFanout uses a tx with .insert().
// We compose a unified fake tx so withTenantDb can serve both code paths.
const fakeSelectDb = {
  from: (tbl: unknown) => {
    if (drizzleTableName(tbl) === "subagent_runs") {
      return { where: async () => mocks.runsRows };
    }
    return { where: () => ({ limit: mocks.limitFanout }) };
  },
};
const fakeUnifiedTx = {
  insert: fakeTx.insert.bind(fakeTx),
  select: () => fakeSelectDb,
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    db: () => ({
      transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>) =>
        fn(fakeTx),
      select: () => fakeSelectDb,
    }),
    withTenantDb: async (fn: (tx: typeof fakeUnifiedTx) => Promise<unknown>) =>
      fn(fakeUnifiedTx),
  };
});

vi.mock("inngest", () => ({
  Inngest: vi.fn(() => ({ send: mocks.inngestSend })),
}));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({ INNGEST_EVENT_KEY: "test" }),
}));

import { dispatchFanout, readFanout } from "./subagent";

describe("subagent dispatch", () => {
  beforeEach(() => {
    mocks.txInsertCalls.length = 0;
    mocks.inngestSend.mockClear();
    mocks.runsRows = [];
    mocks.limitFanout.mockImplementation(async () => [mocks.fanoutRow]);
  });

  it("dispatchFanout inserts fanout + child rows in one batch and sends Inngest event", async () => {
    const res = await dispatchFanout({
      orgId: "ten_1",
      workspaceId: "ws_1",
      parentMessageId: "msg_parent",
      children: [
        { capability: "recall_memory", input: { q: "a" } },
        { capability: "recall_memory", input: { q: "b" } },
        { capability: "recall_memory", input: { q: "c" } },
      ],
    });

    expect(res.fanoutId).toBe("fan_123");
    expect(res.childMessageIds).toHaveLength(3);

    // Exactly 2 inserts: one fanout row + one batched runs insert.
    expect(mocks.txInsertCalls).toHaveLength(2);
    expect(mocks.txInsertCalls[0]!.table).toBe("subagent_fanouts");
    expect(mocks.txInsertCalls[1]!.table).toBe("subagent_runs");
    expect(Array.isArray(mocks.txInsertCalls[1]!.values)).toBe(true);
    expect((mocks.txInsertCalls[1]!.values as unknown[]).length).toBe(3);

    expect(mocks.inngestSend).toHaveBeenCalledTimes(1);
    const evt = (
      mocks.inngestSend.mock.calls[0] as unknown as [
        { name: string; data: Record<string, unknown> },
      ]
    )[0]!;
    expect(evt.name).toBe("agent/subagent.dispatch");
    expect(evt.data.fanoutId).toBe("fan_123");
    expect(evt.data.orgId).toBe("ten_1");
  });

  it("readFanout returns current state when fanout exists", async () => {
    mocks.runsRows = [
      {
        childMessageId: "c1",
        capabilityName: "recall_memory",
        status: "completed",
        outputPayload: { result: 1 },
        errorReason: null,
      },
    ];
    const snap = await readFanout("fan_123", "ten_1", "ws_1");
    expect(snap).not.toBeNull();
    expect(snap!.fanoutId).toBe("fan_123");
    expect(snap!.status).toBe("pending");
    expect(snap!.results).toHaveLength(1);
    expect(snap!.results[0]!.childMessageId).toBe("c1");
    expect(snap!.results[0]!.capability).toBe("recall_memory");
    expect(snap!.results[0]!.status).toBe("completed");
  });

  it("readFanout returns null when fanout row is absent", async () => {
    mocks.limitFanout.mockImplementationOnce(async () => []);
    const snap = await readFanout("missing", "ten_1", "ws_1");
    expect(snap).toBeNull();
  });
});
