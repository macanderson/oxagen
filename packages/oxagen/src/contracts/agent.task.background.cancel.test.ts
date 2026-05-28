import { describe, expect, it } from "vitest";
import { agentTaskBackgroundCancel } from "./agent.task.background.cancel.js";
import { getCapability } from "../registry.js";

describe("agent.task.background.cancel capability", () => {
  it("parses a valid input", () => {
    const parsed = agentTaskBackgroundCancel.input.parse({
      taskId: "task_1",
      reason: "user cancelled",
    });
    expect(parsed.reason).toBe("user cancelled");
  });

  it("parses an input without a reason", () => {
    const parsed = agentTaskBackgroundCancel.input.parse({ taskId: "task_1" });
    expect(parsed.reason).toBeUndefined();
  });

  it("rejects a missing taskId", () => {
    expect(() => agentTaskBackgroundCancel.input.parse({})).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentTaskBackgroundCancel.output.parse({
      taskId: "task_1",
      status: "cancelled",
    });
    expect(parsed.status).toBe("cancelled");
  });

  it("rejects an unknown output status", () => {
    expect(() =>
      agentTaskBackgroundCancel.output.parse({
        taskId: "task_1",
        status: "stopped",
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("agent.task.background.cancel")).toBe(
      agentTaskBackgroundCancel,
    );
  });
});
