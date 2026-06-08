import { describe, expect, it } from "vitest";
import { workflowRun } from "./workflow.run";
import { getCapability } from "../registry";

describe("workflow.run capability", () => {
  it("parses valid input with required fields", () => {
    const parsed = workflowRun.input.parse({
      goal: "Process 10 datasets in parallel",
    });
    expect(parsed.goal).toBe("Process 10 datasets in parallel");
    expect(parsed.maxParallelism).toBe(50);
    expect(parsed.outputFormat).toBe("json");
  });

  it("parses valid input with all optional fields", () => {
    const parsed = workflowRun.input.parse({
      goal: "Research market trends",
      title: "Q2 Market Analysis",
      outputFormat: "csv",
      maxParallelism: 25,
    });
    expect(parsed.title).toBe("Q2 Market Analysis");
    expect(parsed.outputFormat).toBe("csv");
    expect(parsed.maxParallelism).toBe(25);
  });

  it("rejects goal longer than 2000 chars", () => {
    expect(() =>
      workflowRun.input.parse({
        goal: "x".repeat(2001),
      }),
    ).toThrow();
  });

  it("rejects maxParallelism > 100", () => {
    expect(() =>
      workflowRun.input.parse({
        goal: "Test goal",
        maxParallelism: 101,
      }),
    ).toThrow();
  });

  it("parses valid output", () => {
    const parsed = workflowRun.output.parse({
      workflowId: "550e8400-e29b-41d4-a716-446655440000",
      publicId: "wfr_abc123",
      status: "planning",
      render: {
        componentId: "workflow-progress",
        props: { workflowId: "550e8400-e29b-41d4-a716-446655440000" },
      },
    });
    expect(parsed.publicId).toBe("wfr_abc123");
    expect(parsed.render.componentId).toBe("workflow-progress");
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("workflow.run")).toBe(workflowRun);
  });
});
