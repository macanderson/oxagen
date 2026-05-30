import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchFanoutMock: vi.fn(),
}));

mocks.dispatchFanoutMock.mockImplementation(async () => ({
  fanoutId: "fan_abc",
  childMessageIds: ["c1", "c2"],
}));

vi.mock("../dispatch/subagent.js", () => ({
  dispatchFanout: mocks.dispatchFanoutMock,
}));

import { agentSubagentDispatchHandler } from "./agent.subagent.dispatch.js";

const CTX = {
  orgId: "ten_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1", surface: "runner" as const, messageId: null,
};

describe("agent.subagent.dispatch handler", () => {
  beforeEach(() => {
    mocks.dispatchFanoutMock.mockClear();
  });

  it("forwards inputs to dispatchFanout with context-derived scope", async () => {
    const res = await agentSubagentDispatchHandler(
      {
        parentMessageId: "msg_p",
        fanout: [
          { capability: "agent.memory.recall", input: { q: "a" } },
          { capability: "agent.memory.recall", input: { q: "b" } },
        ],
      },
      CTX,
    );
    expect(mocks.dispatchFanoutMock).toHaveBeenCalledTimes(1);
    const arg = mocks.dispatchFanoutMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.orgId).toBe("ten_1");
    expect(arg.workspaceId).toBe("ws_1");
    expect(arg.parentMessageId).toBe("msg_p");
    expect(Array.isArray(arg.children)).toBe(true);
    expect((arg.children as unknown[]).length).toBe(2);
    expect(res.fanoutId).toBe("fan_abc");
    expect(res.childMessageIds).toEqual(["c1", "c2"]);
  });
});
