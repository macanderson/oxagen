import { describe, expect, it } from "vitest";
import { agentTaskBackgroundStart } from "./agent.task.background.start.js";
import { getCapability } from "../registry.js";

describe("agent.task.background.start capability", () => {
  it("parses a valid input", () => {
    const parsed = agentTaskBackgroundStart.input.parse({
      kind: "ontology.reindex",
      payload: { repoId: "repo_1" },
      label: "Reindex graph",
    });
    expect(parsed.kind).toBe("ontology.reindex");
  });

  it("rejects a missing kind", () => {
    expect(() =>
      agentTaskBackgroundStart.input.parse({ payload: {} }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentTaskBackgroundStart.output.parse({
      taskId: "task_1",
      inngestRunId: "01HZX...",
    });
    expect(parsed.taskId).toBe("task_1");
  });

  it("rejects a missing inngestRunId", () => {
    expect(() =>
      agentTaskBackgroundStart.output.parse({ taskId: "task_1" }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("agent.task.background.start")).toBe(
      agentTaskBackgroundStart,
    );
  });
});
