/**
 * workflows.test.ts — unit tests for the workflow.* / research.swarm.*
 * invoke() wrappers backing the Workflows & swarms page.
 *
 * Mock seam: @oxagen/oxagen → invoke, plus each contract module (passthrough
 * parse). Verifies each helper dispatches the right capability name with the
 * right input shape (contract-valid bounds), threads ctx, and — critically —
 * omits opts.surface (exactly 3 args to invoke) so the kernel surface gate
 * stays skipped and ctx.surface="app" is the attribution used. Also covers
 * listWorkflowRuns' originType filter and bounded enrichment fan-out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/oxagen", () => ({ invoke: vi.fn() }));

// vi.hoisted so `passthrough` is initialized before the hoisted vi.mock
// factories below reference it (plain const would be in its TDZ at mock time).
const { passthrough } = vi.hoisted(() => ({
  passthrough: (name: string) => ({
    name,
    input: { parse: (v: unknown) => v },
    output: { parse: (v: unknown) => v },
  }),
}));
vi.mock("@oxagen/oxagen/contracts/workflow.run", () => ({
  workflowRun: passthrough("run_workflow"),
}));
vi.mock("@oxagen/oxagen/contracts/workflow.status", () => ({
  workflowStatus: passthrough("get_workflow_status"),
}));
vi.mock("@oxagen/oxagen/contracts/workflow.cancel", () => ({
  workflowCancel: passthrough("cancel_workflow"),
}));
vi.mock("@oxagen/oxagen/contracts/research.swarm.start", () => ({
  researchSwarmStart: passthrough("start_research_swarm"),
}));
vi.mock("@oxagen/oxagen/contracts/research.swarm.status", () => ({
  researchSwarmStatus: passthrough("get_research_status"),
}));
vi.mock("@oxagen/oxagen/contracts/agent.execution.list", () => ({
  agentExecutionList: passthrough("list_executions"),
}));

import { invoke } from "@oxagen/oxagen";
import {
  runWorkflow,
  getWorkflowStatus,
  cancelWorkflow,
  startResearchSwarm,
  getResearchStatus,
  listWorkflowRuns,
} from "./workflows";
import type { AutomationsCtx } from "./scope";

const mockInvoke = vi.mocked(invoke);

const CTX: AutomationsCtx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "app",
  messageId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("workflow.* helpers", () => {
  it("runWorkflow dispatches run_workflow with contract-valid input, no opts", async () => {
    mockInvoke.mockResolvedValue({ workflowId: "w1" });
    const input = {
      goal: "Summarize 50 competitor changelogs",
      title: "Competitor sweep",
      outputFormat: "json" as const,
      maxParallelism: 25,
    };
    await runWorkflow(CTX, input);
    expect(mockInvoke).toHaveBeenCalledWith("run_workflow", input, CTX);
    expect(mockInvoke.mock.calls[0]).toHaveLength(3);
  });

  it("getWorkflowStatus dispatches get_workflow_status with the workflow id", async () => {
    mockInvoke.mockResolvedValue({ workflow: {}, tasks: [] });
    await getWorkflowStatus(CTX, "wfr_123");
    expect(mockInvoke).toHaveBeenCalledWith(
      "get_workflow_status",
      { workflowId: "wfr_123" },
      CTX,
    );
  });

  it("cancelWorkflow dispatches cancel_workflow with the workflow id, no opts", async () => {
    mockInvoke.mockResolvedValue({ cancelled: true });
    await cancelWorkflow(CTX, "wfr_456");
    expect(mockInvoke).toHaveBeenCalledWith(
      "cancel_workflow",
      { workflowId: "wfr_456" },
      CTX,
    );
    expect(mockInvoke.mock.calls[0]).toHaveLength(3);
  });

  it("startResearchSwarm dispatches start_research_swarm with contract-valid input", async () => {
    mockInvoke.mockResolvedValue({ swarmId: "s1" });
    const input = {
      topic: "AI safety funding 2026",
      depth: "deep" as const,
      maxParallel: 10,
      targetLabel: "Topic",
      searchDepth: "advanced" as const,
    };
    await startResearchSwarm(CTX, input);
    expect(mockInvoke).toHaveBeenCalledWith("start_research_swarm", input, CTX);
    expect(mockInvoke.mock.calls[0]).toHaveLength(3);
  });

  it("getResearchStatus dispatches get_research_status with the swarm id", async () => {
    mockInvoke.mockResolvedValue({ swarmId: "s1", status: "running" });
    await getResearchStatus(CTX, "swarm-1");
    expect(mockInvoke).toHaveBeenCalledWith(
      "get_research_status",
      { swarmId: "swarm-1" },
      CTX,
    );
  });
});

describe("listWorkflowRuns", () => {
  const execution = (overrides: Record<string, unknown>) => ({
    executionId: "exec-default",
    status: "completed" as const,
    originType: "workflow_run",
    originId: "user-1",
    agentId: null,
    startedAt: "2026-07-01T00:00:00.000Z",
    completedAt: "2026-07-01T00:05:00.000Z",
    latencyMs: 300_000,
    inputTokens: 100,
    outputTokens: 200,
    estimatedCostUsd: "0.05",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  });

  it("filters agent.execution.list rows to originType === workflow_run", async () => {
    mockInvoke.mockImplementation((name: string) => {
      if (name === "list_executions") {
        return Promise.resolve({
          executions: [
            execution({ executionId: "wf-1", originType: "workflow_run" }),
            execution({ executionId: "chat-1", originType: "chat_message" }),
            execution({
              executionId: "auto-1",
              originType: "automation_trigger",
            }),
          ],
          nextCursor: null,
        });
      }
      if (name === "get_workflow_status") {
        return Promise.resolve({
          workflow: {
            title: "T",
            goal: "G",
            totalTasks: 5,
            completedTasks: 2,
            failedTasks: 0,
          },
          tasks: [],
        });
      }
      return Promise.resolve({});
    });

    const rows = await listWorkflowRuns(CTX);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.executionId).toBe("wf-1");
  });

  it("calls list_executions with limit only, no status/before filter (contract has none)", async () => {
    mockInvoke.mockResolvedValue({ executions: [], nextCursor: null });
    await listWorkflowRuns(CTX);
    expect(mockInvoke).toHaveBeenCalledWith(
      "list_executions",
      { limit: 50 },
      CTX,
    );
  });

  it("enriches only the newest ENRICH_LIMIT (10) rows via get_workflow_status", async () => {
    const runs = Array.from({ length: 15 }, (_, i) =>
      execution({ executionId: `wf-${i}`, originType: "workflow_run" }),
    );
    mockInvoke.mockImplementation((name: string) => {
      if (name === "list_executions") {
        return Promise.resolve({ executions: runs, nextCursor: null });
      }
      if (name === "get_workflow_status") {
        return Promise.resolve({
          workflow: {
            title: "T",
            goal: "G",
            totalTasks: 3,
            completedTasks: 1,
            failedTasks: 0,
          },
          tasks: [],
        });
      }
      return Promise.resolve({});
    });

    const rows = await listWorkflowRuns(CTX);
    expect(rows).toHaveLength(15);
    const enrichedCount = rows.filter((r) => r.enriched).length;
    expect(enrichedCount).toBe(10);
    // Un-enriched rows still carry the base fields for the table.
    const unenriched = rows.find((r) => !r.enriched);
    expect(unenriched?.goal).toBeUndefined();
    expect(unenriched?.status).toBe("completed");
  });

  it("a failed get_workflow_status enrichment leaves the row usable (best-effort)", async () => {
    mockInvoke.mockImplementation((name: string) => {
      if (name === "list_executions") {
        return Promise.resolve({
          executions: [
            execution({ executionId: "wf-err", originType: "workflow_run" }),
          ],
          nextCursor: null,
        });
      }
      if (name === "get_workflow_status") {
        return Promise.reject(new Error("boom"));
      }
      return Promise.resolve({});
    });

    const rows = await listWorkflowRuns(CTX);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enriched).toBe(false);
    expect(rows[0]?.status).toBe("completed");
  });
});
