<<<<<<< HEAD
import { describe, expect, it } from "vitest";
import { workflowStatus } from "./workflow.status";
import { getCapability } from "../registry";

describe("workflow.status capability", () => {
  it("parses valid input with public ID", () => {
    const parsed = workflowStatus.input.parse({
      workflowId: "wfr_abc123",
    });
    expect(parsed.workflowId).toBe("wfr_abc123");
  });

  it("parses valid input with internal UUID", () => {
    const parsed = workflowStatus.input.parse({
      workflowId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(parsed.workflowId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("parses valid output with workflow and tasks", () => {
    const parsed = workflowStatus.output.parse({
      workflow: {
        id: "550e8400-e29b-41d4-a716-446655440000",
        publicId: "wfr_abc123",
        orgId: "org_123",
        workspaceId: "ws_456",
        title: "Data Processing",
        goal: "Process datasets",
        status: "running",
        planJson: {},
        totalTasks: 10,
        completedTasks: 3,
        failedTasks: 0,
        maxParallelism: 50,
        outputFormat: "json",
        resultUrl: null,
        startedAt: "2026-06-08T00:00:00Z",
        completedAt: null,
        createdAt: "2026-06-08T00:00:00Z",
        updatedAt: "2026-06-08T00:00:00Z",
      },
      tasks: [
        {
          id: "wft_1",
          publicId: "wft_pub_1",
          workflowRunId: "wfr_abc123",
          taskIndex: 0,
          title: "Task 1",
          goal: "Complete task 1",
          status: "completed",
          inngestRunId: "inngest_1",
          outputJson: { result: "done" },
          error: null,
          startedAt: "2026-06-08T00:00:00Z",
          completedAt: "2026-06-08T00:01:00Z",
          createdAt: "2026-06-08T00:00:00Z",
        },
      ],
    });
    expect(parsed.workflow.status).toBe("running");
    expect(parsed.tasks).toHaveLength(1);
    expect(parsed.tasks[0]?.status).toBe("completed");
  });

  it("rejects invalid workflow status", () => {
    expect(() =>
      workflowStatus.output.parse({
        workflow: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          publicId: "wfr_abc123",
          orgId: "org_123",
          workspaceId: "ws_456",
          title: "Data Processing",
          goal: "Process datasets",
          status: "unknown",
          planJson: {},
          totalTasks: 10,
          completedTasks: 3,
          failedTasks: 0,
          maxParallelism: 50,
          outputFormat: "json",
          resultUrl: null,
          startedAt: null,
          completedAt: null,
          createdAt: "2026-06-08T00:00:00Z",
          updatedAt: "2026-06-08T00:00:00Z",
        },
=======
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
    expect(getCapability("workflow.status")).toBeDefined();
  });

  it("parses a valid input", () => {
    expect(() =>
      workflowStatus.input.parse({ workflowId: "wfr_abc123" }),
    ).not.toThrow();
  });

  it("rejects input missing workflowId", () => {
    expect(() =>
      workflowStatus.input.parse({}),
    ).toThrow();
  });

  it("rejects input with empty workflowId", () => {
    expect(() =>
      workflowStatus.input.parse({ workflowId: "" }),
    ).toThrow();
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
    expect(() =>
      workflowStatus.output.parse({ tasks: [] }),
    ).toThrow();
  });

  it("rejects output with invalid workflow status", () => {
    expect(() =>
      workflowStatus.output.parse({
        workflow: { ...validWorkflow, status: "unknown" },
>>>>>>> 904f4b0 ((chore):checkpoint)
        tasks: [],
      }),
    ).toThrow();
  });

<<<<<<< HEAD
  it("is registered in the capability registry", () => {
    expect(getCapability("workflow.status")).toBe(workflowStatus);
=======
  it("has correct defaultEffect and defaultRoles", () => {
    expect(workflowStatus.defaultEffect).toBe("deny");
    expect(workflowStatus.defaultRoles?.org?.Owner).toBe("allow");
    expect(workflowStatus.defaultRoles?.workspace?.Member).toBe("allow");
>>>>>>> 904f4b0 ((chore):checkpoint)
  });
});
