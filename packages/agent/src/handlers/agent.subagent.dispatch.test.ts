import { describe, expect, it, vi, beforeEach } from "vitest";
import { getTableName } from "drizzle-orm";

// Track DB insert calls and Inngest send calls. The fan-out insert returns BOTH
// the internal uuid (`id`) and the external `publicId`; the handler stores `id`
// as subagent_runs.fanout_id and returns `publicId` as the dispatchId.
const insertFanoutSpy = vi.fn(async () => [{ id: "fanuuid_123", publicId: "fan_123" }]);
// Captures the rows passed to the subagent_runs batch insert so tests can
// assert the fanout_id uuid and per-child message ids are correct.
let insertedRuns: Array<Record<string, unknown>> = [];
// Captures `.set()` payloads for the post-emit UPDATEs so tests can assert the
// persisted inngest_event_id and the on-emit-failure run cleanup.
let fanoutUpdates: Array<Record<string, unknown>> = [];
let runUpdates: Array<Record<string, unknown>> = [];
// send() resolves to Inngest's real shape ({ ids: [...] }); tests can override.
const inngestSendSpy = vi.fn(async () => ({ ids: ["evt_abc"] }));

const drizzleTableName = (table: unknown): string => {
  try {
    return getTableName(table as Parameters<typeof getTableName>[0]);
  } catch {
    return "unknown";
  }
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
  ...real,
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      insert: (table: unknown) => ({
        values: (vals: unknown) => {
          if (drizzleTableName(table) === "subagent_runs" && Array.isArray(vals)) {
            insertedRuns.push(...(vals as Array<Record<string, unknown>>));
          }
          return {
            returning: insertFanoutSpy,
            // The runs insert is awaited without .returning(); make it thenable.
            then: (resolve: (x: unknown) => void) => resolve(undefined),
          };
        },
      }),
      update: (table: unknown) => ({
        set: (vals: Record<string, unknown>) => ({
          where: () => {
            const name = drizzleTableName(table);
            if (name === "subagent_fanouts") fanoutUpdates.push(vals);
            if (name === "subagent_runs") runUpdates.push(vals);
            return Promise.resolve(undefined);
          },
        }),
      }),
    }),

  };
});

vi.mock("../dispatch/inngest-client", () => ({
  getInngestClient: () => ({ send: inngestSendSpy }),
}));

// Deterministic registry: only these names are "registered". Unknown names are
// rejected by the dispatch hardening; agent.code.execute is high-risk so its
// timeout ceiling (300s) drives the clamp test.
vi.mock("../registry-loader", () => ({
  getOxagenRegistry: async () => ({
    listCapabilities: () => [],
    getSurfaces: () => [],
    getCapability: (name: string) =>
      (
        {
          "agent.tool.list": { name, agent: { riskLevel: "low" as const } },
          "agent.memory.recall": { name, agent: { riskLevel: "low" as const } },
          "agent.code.execute": { name, agent: { riskLevel: "high" as const } },
        } as Record<string, { name: string; agent: { riskLevel: "low" | "medium" | "high" } }>
      )[name],
  }),
}));

import { agentSubagentDispatchHandler } from "./agent.subagent.dispatch";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

describe("agent.subagent.dispatch handler", () => {
  beforeEach(() => {
    insertFanoutSpy.mockClear();
    inngestSendSpy.mockClear();
    insertedRuns = [];
    fanoutUpdates = [];
    runUpdates = [];
    // Reset insert mock to return fanout row by default
    insertFanoutSpy.mockResolvedValue([{ id: "fanuuid_123", publicId: "fan_123" }]);
    // Reset send mock to the success shape by default.
    inngestSendSpy.mockResolvedValue({ ids: ["evt_abc"] });
  });

  it("creates a fanout record and queues an Inngest event keyed by the uuid", async () => {
    const result = await agentSubagentDispatchHandler(
      {
        parentMessageId: "msg_1",
        tasks: [
          { capabilityName: "agent.tool.list", input: {} },
          { capabilityName: "agent.memory.recall", input: { query: "foo" } },
        ],
        maxParallel: 5,
      },
      CTX,
    );

    // Callers receive the external public_id as the dispatchId.
    expect(result.dispatchId).toBe("fan_123");
    expect(result.totalTasks).toBe(2);
    expect(result.status).toBe("pending");
    expect(inngestSendSpy).toHaveBeenCalledTimes(1);
    const sentEvent = (inngestSendSpy.mock.calls[0] as unknown as [{ name: string; data: { fanoutId: string; depth: number; maxParallel: number } }])[0];
    expect(sentEvent.name).toBe("agent/subagent.dispatch");
    // The executor matches on the uuid, NOT the public_id.
    expect(sentEvent.data.fanoutId).toBe("fanuuid_123");
    expect(sentEvent.data.depth).toBe(1);
    expect(sentEvent.data.maxParallel).toBe(5);
  });

  it("stores the fan-out uuid in fanout_id and a unique childMessageId per run", async () => {
    await agentSubagentDispatchHandler(
      {
        parentMessageId: "msg_parent",
        tasks: [
          { capabilityName: "agent.tool.list", input: {} },
          { capabilityName: "agent.memory.recall", input: { query: "foo" } },
        ],
        maxParallel: 5,
      },
      CTX,
    );

    expect(insertedRuns).toHaveLength(2);
    // Every run references the fan-out by its uuid — never the public_id (which
    // would fail the uuid column) and never the parentMessageId.
    for (const row of insertedRuns) {
      expect(row.fanoutId).toBe("fanuuid_123");
      expect(row.childMessageId).not.toBe("msg_parent");
    }
    // Per-child message ids must be distinct (regression: all rows previously
    // reused parentMessageId, which collides under any uniqueness constraint).
    const childIds = insertedRuns.map((r) => r.childMessageId);
    expect(new Set(childIds).size).toBe(childIds.length);
  });

  it("throws when DB insert returns no row", async () => {
    insertFanoutSpy.mockResolvedValueOnce([]);
    await expect(
      agentSubagentDispatchHandler(
        {
          parentMessageId: "msg_2",
          tasks: [{ capabilityName: "agent.tool.list", input: {} }],
          maxParallel: 2,
        },
        CTX,
      ),
    ).rejects.toThrow("subagent_fanouts insert failed");
    expect(inngestSendSpy).not.toHaveBeenCalled();
  });

  it("propagates maxParallel to the Inngest event", async () => {
    await agentSubagentDispatchHandler(
      {
        parentMessageId: "msg_3",
        tasks: [{ capabilityName: "agent.tool.list", input: {} }],
        maxParallel: 10,
      },
      CTX,
    );
    const sentEvent = (inngestSendSpy.mock.calls[0] as unknown as [{ name: string; data: { maxParallel: number } }])[0];
    expect(sentEvent.data.maxParallel).toBe(10);
  });

  it("rejects an unknown capability name before creating any rows", async () => {
    await expect(
      agentSubagentDispatchHandler(
        {
          parentMessageId: "msg_bad",
          tasks: [{ capabilityName: "agent.bogus.nope", input: {} }],
          maxParallel: 2,
        },
        CTX,
      ),
    ).rejects.toThrow(/Unknown capability name/);
    expect(insertFanoutSpy).not.toHaveBeenCalled();
    expect(inngestSendSpy).not.toHaveBeenCalled();
  });

  it("clamps timeoutSeconds to the per-risk ceiling (high → 300s)", async () => {
    await agentSubagentDispatchHandler(
      {
        parentMessageId: "msg_to",
        tasks: [{ capabilityName: "agent.code.execute", input: {} }],
        maxParallel: 1,
        timeoutSeconds: 3600,
      },
      CTX,
    );
    const sentEvent = (inngestSendSpy.mock.calls[0] as unknown as [{ data: { timeoutSeconds: number } }])[0];
    expect(sentEvent.data.timeoutSeconds).toBe(300);
  });

  it("persists the returned Inngest event id on the fan-out (trace breadcrumb)", async () => {
    inngestSendSpy.mockResolvedValueOnce({ ids: ["evt_xyz"] });
    await agentSubagentDispatchHandler(
      {
        parentMessageId: "msg_evt",
        tasks: [{ capabilityName: "agent.tool.list", input: {} }],
        maxParallel: 1,
      },
      CTX,
    );
    // The fan-out row is updated with the event id so a dispatch that never
    // fired can be traced from the DB to the Inngest dashboard.
    expect(fanoutUpdates).toEqual([{ inngestEventId: "evt_xyz" }]);
    expect(runUpdates).toHaveLength(0);
  });

  it("marks child runs failed and rethrows when the Inngest emit throws", async () => {
    inngestSendSpy.mockRejectedValueOnce(new Error("INNGEST_EVENT_KEY missing"));
    await expect(
      agentSubagentDispatchHandler(
        {
          parentMessageId: "msg_fail",
          tasks: [
            { capabilityName: "agent.tool.list", input: {} },
            { capabilityName: "agent.memory.recall", input: { query: "x" } },
          ],
          maxParallel: 5,
        },
        CTX,
      ),
    ).rejects.toThrow(/Failed to emit subagent dispatch event: INNGEST_EVENT_KEY missing/);
    // The just-created child runs are marked failed with the cause, not left
    // orphaned as perpetually `pending`. No event id was persisted.
    expect(runUpdates).toEqual([
      {
        status: "failed",
        errorReason: "dispatch emit failed: INNGEST_EVENT_KEY missing",
        completedAt: expect.any(Date),
      },
    ]);
    expect(fanoutUpdates).toHaveLength(0);
  });
});
