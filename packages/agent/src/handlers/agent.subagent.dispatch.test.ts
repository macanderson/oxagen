import { describe, expect, it, vi, beforeEach } from "vitest";

// Track DB insert calls and Inngest send calls.
const insertFanoutSpy = vi.fn(async () => [{ publicId: "fan_123" }]);
const insertRunsSpy = vi.fn(async () => []);
const findRunsSpy = vi.fn(async () => [
  { publicId: "sar_1", capabilityName: "agent.tool.list", inputPayload: {} },
  { publicId: "sar_2", capabilityName: "agent.memory.recall", inputPayload: { query: "foo" } },
]);
const inngestSendSpy = vi.fn(async () => undefined);

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
  ...real,
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      insert: () => ({
        values: () => ({
          returning: insertFanoutSpy,
        }),
      }),
      query: {
        subagentRuns: { findMany: findRunsSpy },
      },
    }),

  };
});

vi.mock("../dispatch/inngest-client", () => ({
  getInngestClient: () => ({ send: inngestSendSpy }),
}));

import { agentSubagentDispatchHandler } from "./agent.subagent.dispatch";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

describe("agent.subagent.dispatch handler", () => {
  beforeEach(() => {
    insertFanoutSpy.mockClear();
    insertRunsSpy.mockClear();
    findRunsSpy.mockClear();
    inngestSendSpy.mockClear();
    // Reset insert mock to return fanout row by default
    insertFanoutSpy.mockResolvedValue([{ publicId: "fan_123" }]);
  });

  it("creates a fanout record and queues an Inngest event", async () => {
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

    expect(result.dispatchId).toBe("fan_123");
    expect(result.totalTasks).toBe(2);
    expect(result.status).toBe("pending");
    expect(inngestSendSpy).toHaveBeenCalledTimes(1);
    const sentEvent = (inngestSendSpy.mock.calls[0] as unknown as [{ name: string; data: { dispatchId: string; maxParallel: number } }])[0];
    expect(sentEvent.name).toBe("agent/subagent.dispatch");
    expect(sentEvent.data.dispatchId).toBe("fan_123");
    expect(sentEvent.data.maxParallel).toBe(5);
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
});
