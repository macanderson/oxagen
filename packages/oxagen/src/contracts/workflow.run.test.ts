import { describe, it, expect } from "vitest";
import { workflowRun } from "./workflow.run";
import { getCapability } from "../registry";

describe("workflow.run capability", () => {
  it("is registered", () => {
    expect(getCapability("run_workflow")).toBeDefined();
  });

  it("parses a valid minimal input", () => {
    expect(() =>
      workflowRun.input.parse({
        goal: "Research competitors and summarise findings",
      }),
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
    expect(() => workflowRun.input.parse({ goal: "" })).toThrow();
  });

  it("rejects goal exceeding 2000 characters", () => {
    expect(() => workflowRun.input.parse({ goal: "x".repeat(2001) })).toThrow();
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
        render: {
          componentId: "workflow-progress",
          props: { workflowId: "018fae12-0000-7000-8000-000000000001" },
        },
      }),
    ).not.toThrow();
  });

  it("rejects output with wrong status", () => {
    expect(() =>
      workflowRun.output.parse({
        workflowId: "018fae12-0000-7000-8000-000000000001",
        publicId: "wfr_abc123",
        status: "running",
        render: {
          componentId: "workflow-progress",
          props: { workflowId: "018fae12-0000-7000-8000-000000000001" },
        },
      }),
    ).toThrow();
  });

  it("has correct defaultEffect and defaultRoles", () => {
    expect(workflowRun.defaultEffect).toBe("deny");
    expect(workflowRun.defaultRoles?.org?.Owner).toBe("allow");
    expect(workflowRun.defaultRoles?.workspace?.Member).toBe("allow");
  });
});
