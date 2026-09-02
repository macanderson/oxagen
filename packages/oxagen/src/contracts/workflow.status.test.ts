import { describe, it, expect } from "vitest";
import { workflowStatus } from "./workflow.status";
import { getCapability } from "../registry";

const validWorkflow = {
  id: "018fae12-0000-7000-8000-000000000001",
  publicId: "wfr_abc123",
  orgId: "018fae12-0000-7000-8000-000000000002",
  workspaceId: "018fae12-0000-7000-8000-000000000003",
  title: "Competitor Research",
  goal: "Research competitors and summarise findings",
  status: "running" as const,
  planJson: null,
  totalTasks: 10,
  completedTasks: 3,
  failedTasks: 0,
  maxParallelism: 50,
  outputFormat: "json" as const,
  resultUrl: null,
  startedAt: "2024-01-01T00:00:00.000Z",
  completedAt: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:01.000Z",
};

const validTask = {
  id: "018fae12-0000-7000-8000-000000000010",
  publicId: "wft_task1",
  workflowRunId: "018fae12-0000-7000-8000-000000000001",
  taskIndex: 0,
  title: "Research competitor A",
  goal: "Summarise competitor A's product offering",
  status: "completed" as const,
  inngestRunId: "01HX000000000000000000000A",
  outputJson: { summary: "Competitor A focuses on..." },
  error: null,
  startedAt: "2024-01-01T00:00:00.500Z",
  completedAt: "2024-01-01T00:00:05.000Z",
  createdAt: "2024-01-01T00:00:00.000Z",
};

describe("workflow.status capability", () => {
  it("is registered", () => {
    expect(getCapability("get_workflow_status")).toBeDefined();
  });

  it("parses a valid input", () => {
    expect(() =>
      workflowStatus.input.parse({ workflowId: "wfr_abc123" }),
    ).not.toThrow();
  });

  it("rejects input missing workflowId", () => {
    expect(() => workflowStatus.input.parse({})).toThrow();
  });

  it("rejects input with empty workflowId", () => {
    expect(() => workflowStatus.input.parse({ workflowId: "" })).toThrow();
  });

  it("parses a valid output with workflow and tasks", () => {
    expect(() =>
      workflowStatus.output.parse({
        workflow: validWorkflow,
        tasks: [validTask],
      }),
    ).not.toThrow();
  });

  it("parses a valid output with empty tasks array", () => {
    expect(() =>
      workflowStatus.output.parse({
        workflow: validWorkflow,
        tasks: [],
      }),
    ).not.toThrow();
  });

  it("rejects output missing workflow field", () => {
    expect(() => workflowStatus.output.parse({ tasks: [] })).toThrow();
  });

  it("rejects output with invalid workflow status", () => {
    expect(() =>
      workflowStatus.output.parse({
        workflow: { ...validWorkflow, status: "unknown" },
        tasks: [],
      }),
    ).toThrow();
  });

  it("has correct defaultEffect and defaultRoles", () => {
    expect(workflowStatus.defaultEffect).toBe("deny");
    expect(workflowStatus.defaultRoles?.org?.Owner).toBe("allow");
    expect(workflowStatus.defaultRoles?.workspace?.Member).toBe("allow");
  });
});
