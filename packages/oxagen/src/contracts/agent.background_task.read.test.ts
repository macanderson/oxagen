import { describe, expect, it } from "vitest";
import { agentTaskBackgroundRead } from "./agent.background_task.read";
import { getCapability } from "../registry";

describe("agent.task.background.read capability", () => {
  it("parses a valid input", () => {
    const parsed = agentTaskBackgroundRead.input.parse({ taskId: "task_1" });
    expect(parsed.taskId).toBe("task_1");
  });

  it("rejects a missing taskId", () => {
    expect(() => agentTaskBackgroundRead.input.parse({})).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentTaskBackgroundRead.output.parse({
      taskId: "task_1",
      kind: "ontology.reindex",
      status: "running",
      label: "Reindex",
      resultPayload: null,
      failureReason: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
    });
    expect(parsed.status).toBe("running");
  });

  it("rejects an unknown status", () => {
    expect(() =>
      agentTaskBackgroundRead.output.parse({
        taskId: "task_1",
        kind: "x",
        status: "queued",
        label: null,
        resultPayload: null,
        failureReason: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("get_background_task")).toBe(agentTaskBackgroundRead);
  });
});
