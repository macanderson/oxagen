import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  readFanout: vi.fn(),
}));

vi.mock("../dispatch/subagent", () => ({
  readFanout: mocks.readFanout,
}));

import { agentSubagentAggregateHandler } from "./agent.subagent.aggregate";
import type { FanoutSnapshot } from "../dispatch/subagent";

// ─────────────────────────────────────────────────────────────────────────────

const CTX = {
  orgId: "org_1",
  workspaceId: "ws_1",
  userId: "u_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner" as const,
  messageId: null,
};

const completedFanout: FanoutSnapshot = {
  fanoutId: "fan_abc",
  status: "completed",
  results: [
    { childMessageId: "c1", capability: "agent.memory.recall", status: "completed", output: { text: "hi" }, error: null },
    { childMessageId: "c2", capability: "agent.memory.recall", status: "completed", output: { text: "yo" }, error: null },
  ],
};

const pendingFanout: FanoutSnapshot = {
  fanoutId: "fan_abc",
  status: "pending",
  results: [
    { childMessageId: "c1", capability: "agent.memory.recall", status: "pending", output: null, error: null },
  ],
};

const partialFanout: FanoutSnapshot = {
  fanoutId: "fan_abc",
  status: "partial",
  results: [
    { childMessageId: "c1", capability: "cap.a", status: "completed", output: {}, error: null },
    { childMessageId: "c2", capability: "cap.b", status: "failed", output: null, error: "oops" },
  ],
};

describe("agent.subagent.aggregate handler", () => {
  beforeEach(() => {
    mocks.readFanout.mockClear();
  });

  // ── happy-path: all done, no wait ─────────────────────────────────────────

  it("returns immediately when waitForCompletion=false regardless of child status", async () => {
    mocks.readFanout.mockResolvedValueOnce(pendingFanout);

    const result = await agentSubagentAggregateHandler(
      { fanoutId: "fan_abc", waitForCompletion: false, timeoutMs: 5000 },
      CTX,
    );

    expect(mocks.readFanout).toHaveBeenCalledTimes(1);
    expect(result.fanoutId).toBe("fan_abc");
    expect(result.status).toBe("pending");
  });

  it("returns the fanout snapshot when all children are done", async () => {
    mocks.readFanout.mockResolvedValueOnce(completedFanout);

    const result = await agentSubagentAggregateHandler(
      { fanoutId: "fan_abc", waitForCompletion: true, timeoutMs: 5000 },
      CTX,
    );

    expect(result.status).toBe("completed");
    expect(result.results).toHaveLength(2);
  });

  it("returns partial fanout immediately when all children have terminal status", async () => {
    mocks.readFanout.mockResolvedValueOnce(partialFanout);

    const result = await agentSubagentAggregateHandler(
      { fanoutId: "fan_abc", waitForCompletion: true, timeoutMs: 5000 },
      CTX,
    );

    expect(result.status).toBe("partial");
    expect(mocks.readFanout).toHaveBeenCalledTimes(1);
  });

  // ── tenant guard ──────────────────────────────────────────────────────────

  it("throws when the fanout is not found (tenant isolation: null return)", async () => {
    mocks.readFanout.mockResolvedValueOnce(null);

    await expect(
      agentSubagentAggregateHandler(
        { fanoutId: "fan_unknown", waitForCompletion: false, timeoutMs: 1000 },
        CTX,
      ),
    ).rejects.toThrow("Fanout fan_unknown not found in tenant");
  });

  it("passes orgId from context to readFanout (tenant isolation)", async () => {
    mocks.readFanout.mockResolvedValueOnce(completedFanout);

    await agentSubagentAggregateHandler(
      { fanoutId: "fan_abc", waitForCompletion: false, timeoutMs: 1000 },
      CTX,
    );

    expect(mocks.readFanout).toHaveBeenCalledWith("fan_abc", "org_1");
  });

  // ── timeout path ──────────────────────────────────────────────────────────

  it("returns status=timed_out once the deadline passes with a pending child", async () => {
    // Always return a pending child so the while loop never exits early
    mocks.readFanout.mockResolvedValue(pendingFanout);

    const result = await agentSubagentAggregateHandler(
      // Very short timeout so the test completes fast
      { fanoutId: "fan_abc", waitForCompletion: true, timeoutMs: 1 },
      CTX,
    );

    expect(result.status).toBe("timed_out");
    // readFanout must have been called at least once before timeout
    expect(mocks.readFanout.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
