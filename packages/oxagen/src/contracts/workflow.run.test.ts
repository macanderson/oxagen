<<<<<<< HEAD
import { describe, expect, it } from "vitest";
=======
import { describe, it, expect } from "vitest";
>>>>>>> 904f4b0 ((chore):checkpoint)
import { workflowRun } from "./workflow.run";
import { getCapability } from "../registry";

describe("workflow.run capability", () => {
<<<<<<< HEAD
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
=======
  it("is registered", () => {
    expect(getCapability("workflow.run")).toBeDefined();
  });

  it("parses a valid minimal input", () => {
    expect(() =>
      workflowRun.input.parse({ goal: "Research competitors and summarise findings" }),
    ).not.toThrow();
  });

  it("parses a fully specified input", () => {
    expect(() =>
      workflowRun.input.parse({
        goal: "Research competitors and summarise findings",
        title: "Competitor Research",
        outputFormat: "csv",
        maxParallelism: 10,
      }),
    ).not.toThrow();
  });

  it("applies default outputFormat=json when omitted", () => {
    const result = workflowRun.input.parse({ goal: "Do something" });
    expect(result.outputFormat).toBe("json");
  });

  it("applies default maxParallelism=50 when omitted", () => {
    const result = workflowRun.input.parse({ goal: "Do something" });
    expect(result.maxParallelism).toBe(50);
  });

  it("rejects an empty goal", () => {
    expect(() =>
      workflowRun.input.parse({ goal: "" }),
    ).toThrow();
  });

  it("rejects goal exceeding 2000 characters", () => {
    expect(() =>
      workflowRun.input.parse({ goal: "x".repeat(2001) }),
    ).toThrow();
  });

  it("rejects maxParallelism above 100", () => {
    expect(() =>
      workflowRun.input.parse({ goal: "Do something", maxParallelism: 101 }),
    ).toThrow();
  });

  it("rejects maxParallelism below 1", () => {
    expect(() =>
      workflowRun.input.parse({ goal: "Do something", maxParallelism: 0 }),
    ).toThrow();
  });

  it("rejects an invalid outputFormat", () => {
    expect(() =>
      workflowRun.input.parse({ goal: "Do something", outputFormat: "xml" }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    expect(() =>
      workflowRun.output.parse({
        workflowId: "018fae12-0000-7000-8000-000000000001",
        publicId: "wfr_abc123",
        status: "planning",
        render: { componentId: "workflow-progress", props: { workflowId: "018fae12-0000-7000-8000-000000000001" } },
      }),
    ).not.toThrow();
  });

  it("rejects output with wrong status", () => {
    expect(() =>
      workflowRun.output.parse({
        workflowId: "018fae12-0000-7000-8000-000000000001",
        publicId: "wfr_abc123",
        status: "running",
        render: { componentId: "workflow-progress", props: { workflowId: "018fae12-0000-7000-8000-000000000001" } },
>>>>>>> 904f4b0 ((chore):checkpoint)
      }),
    ).toThrow();
  });

<<<<<<< HEAD
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
=======
  it("has correct defaultEffect and defaultRoles", () => {
    expect(workflowRun.defaultEffect).toBe("deny");
    expect(workflowRun.defaultRoles?.org?.Owner).toBe("allow");
    expect(workflowRun.defaultRoles?.workspace?.Member).toBe("allow");
>>>>>>> 904f4b0 ((chore):checkpoint)
  });
});
