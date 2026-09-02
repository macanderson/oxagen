import { describe, expect, it } from "vitest";
import { agentSubagentDispatch } from "./agent.subagent.dispatch";
import { getCapability } from "../registry";

const MINIMAL_TASK = {
  capabilityName: "execute_code",
  input: { code: "x", language: "node" },
};

describe("agent.subagent.dispatch capability", () => {
  // ── input: required fields ────────────────────────────────────────────────

  it("parses minimal valid input", () => {
    const parsed = agentSubagentDispatch.input.parse({
      parentMessageId: "msg_abc123",
      tasks: [MINIMAL_TASK],
    });
    expect(parsed.parentMessageId).toBe("msg_abc123");
    expect(parsed.tasks).toHaveLength(1);
  });

  it("rejects input missing parentMessageId", () => {
    expect(() =>
      agentSubagentDispatch.input.parse({ tasks: [MINIMAL_TASK] }),
    ).toThrow();
  });

  it("rejects input missing tasks", () => {
    expect(() =>
      agentSubagentDispatch.input.parse({ parentMessageId: "msg_abc123" }),
    ).toThrow();
  });

  // ── input: tasks array bounds ─────────────────────────────────────────────

  it("accepts tasks array with 1 item (min)", () => {
    const parsed = agentSubagentDispatch.input.parse({
      parentMessageId: "msg_abc123",
      tasks: [MINIMAL_TASK],
    });
    expect(parsed.tasks).toHaveLength(1);
  });

  it("accepts tasks array with 100 items (max)", () => {
    const tasks = Array.from({ length: 100 }, () => MINIMAL_TASK);
    const parsed = agentSubagentDispatch.input.parse({
      parentMessageId: "msg_abc123",
      tasks,
    });
    expect(parsed.tasks).toHaveLength(100);
  });

  it("rejects an empty tasks array (below min)", () => {
    expect(() =>
      agentSubagentDispatch.input.parse({
        parentMessageId: "msg_abc123",
        tasks: [],
      }),
    ).toThrow();
  });

  it("rejects tasks array with 101 items (above max)", () => {
    const tasks = Array.from({ length: 101 }, () => MINIMAL_TASK);
    expect(() =>
      agentSubagentDispatch.input.parse({
        parentMessageId: "msg_abc123",
        tasks,
      }),
    ).toThrow();
  });

  // ── input: task shape ─────────────────────────────────────────────────────

  it("rejects a task missing capabilityName", () => {
    expect(() =>
      agentSubagentDispatch.input.parse({
        parentMessageId: "msg_abc123",
        tasks: [{ input: {} }],
      }),
    ).toThrow();
  });

  it("rejects wrong type for capabilityName", () => {
    expect(() =>
      agentSubagentDispatch.input.parse({
        parentMessageId: "msg_abc123",
        tasks: [{ capabilityName: 42, input: {} }],
      }),
    ).toThrow();
  });

  it("accepts unknown input shape (z.unknown)", () => {
    const parsed = agentSubagentDispatch.input.parse({
      parentMessageId: "msg_abc123",
      tasks: [
        {
          capabilityName: "some.cap",
          input: { arbitrary: true, nested: { x: 1 } },
        },
      ],
    });
    expect(parsed.tasks[0]?.input).toEqual({
      arbitrary: true,
      nested: { x: 1 },
    });
  });

  // ── input: maxParallel defaults and bounds ─────────────────────────────────

  it("defaults maxParallel to 5", () => {
    const parsed = agentSubagentDispatch.input.parse({
      parentMessageId: "msg_abc123",
      tasks: [MINIMAL_TASK],
    });
    expect(parsed.maxParallel).toBe(5);
  });

  it("accepts maxParallel=1 (min)", () => {
    const parsed = agentSubagentDispatch.input.parse({
      parentMessageId: "msg_abc123",
      tasks: [MINIMAL_TASK],
      maxParallel: 1,
    });
    expect(parsed.maxParallel).toBe(1);
  });

  it("accepts maxParallel=50 (max)", () => {
    const parsed = agentSubagentDispatch.input.parse({
      parentMessageId: "msg_abc123",
      tasks: [MINIMAL_TASK],
      maxParallel: 50,
    });
    expect(parsed.maxParallel).toBe(50);
  });

  it("rejects maxParallel=0 (below min)", () => {
    expect(() =>
      agentSubagentDispatch.input.parse({
        parentMessageId: "msg_abc123",
        tasks: [MINIMAL_TASK],
        maxParallel: 0,
      }),
    ).toThrow();
  });

  it("rejects maxParallel=51 (above max)", () => {
    expect(() =>
      agentSubagentDispatch.input.parse({
        parentMessageId: "msg_abc123",
        tasks: [MINIMAL_TASK],
        maxParallel: 51,
      }),
    ).toThrow();
  });

  it("rejects a non-integer maxParallel", () => {
    expect(() =>
      agentSubagentDispatch.input.parse({
        parentMessageId: "msg_abc123",
        tasks: [MINIMAL_TASK],
        maxParallel: 2.5,
      }),
    ).toThrow();
  });

  // ── input: optional timeoutSeconds ────────────────────────────────────────

  it("accepts timeoutSeconds=1 (min)", () => {
    const parsed = agentSubagentDispatch.input.parse({
      parentMessageId: "msg_abc123",
      tasks: [MINIMAL_TASK],
      timeoutSeconds: 1,
    });
    expect(parsed.timeoutSeconds).toBe(1);
  });

  it("accepts timeoutSeconds=3600 (max)", () => {
    const parsed = agentSubagentDispatch.input.parse({
      parentMessageId: "msg_abc123",
      tasks: [MINIMAL_TASK],
      timeoutSeconds: 3600,
    });
    expect(parsed.timeoutSeconds).toBe(3600);
  });

  it("rejects timeoutSeconds=0 (below min)", () => {
    expect(() =>
      agentSubagentDispatch.input.parse({
        parentMessageId: "msg_abc123",
        tasks: [MINIMAL_TASK],
        timeoutSeconds: 0,
      }),
    ).toThrow();
  });

  it("rejects timeoutSeconds=3601 (above max)", () => {
    expect(() =>
      agentSubagentDispatch.input.parse({
        parentMessageId: "msg_abc123",
        tasks: [MINIMAL_TASK],
        timeoutSeconds: 3601,
      }),
    ).toThrow();
  });

  it("allows timeoutSeconds to be omitted", () => {
    const parsed = agentSubagentDispatch.input.parse({
      parentMessageId: "msg_abc123",
      tasks: [MINIMAL_TASK],
    });
    expect(parsed.timeoutSeconds).toBeUndefined();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid pending output", () => {
    const parsed = agentSubagentDispatch.output.parse({
      dispatchId: "dispatch_xyz",
      totalTasks: 3,
      status: "pending",
    });
    expect(parsed.dispatchId).toBe("dispatch_xyz");
    expect(parsed.totalTasks).toBe(3);
    expect(parsed.status).toBe("pending");
  });

  it("parses a valid running output", () => {
    const parsed = agentSubagentDispatch.output.parse({
      dispatchId: "dispatch_xyz",
      totalTasks: 5,
      status: "running",
    });
    expect(parsed.status).toBe("running");
  });

  it("rejects an unknown status in output", () => {
    expect(() =>
      agentSubagentDispatch.output.parse({
        dispatchId: "dispatch_xyz",
        totalTasks: 1,
        status: "completed",
      }),
    ).toThrow();
  });

  it("rejects output missing dispatchId", () => {
    expect(() =>
      agentSubagentDispatch.output.parse({
        totalTasks: 1,
        status: "pending",
      }),
    ).toThrow();
  });

  it("rejects output missing totalTasks", () => {
    expect(() =>
      agentSubagentDispatch.output.parse({
        dispatchId: "dispatch_xyz",
        status: "pending",
      }),
    ).toThrow();
  });

  it("rejects wrong type for totalTasks", () => {
    expect(() =>
      agentSubagentDispatch.output.parse({
        dispatchId: "dispatch_xyz",
        totalTasks: "five",
        status: "pending",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("dispatch_subagent")).toBe(agentSubagentDispatch);
  });
});
