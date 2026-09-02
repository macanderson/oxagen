import { z } from "zod";
import { registerCapability } from "../registry";

const workflowRunSchema = z.object({
  id: z.string(),
  publicId: z.string(),
  orgId: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  goal: z.string(),
  status: z.enum(["planning", "running", "completed", "failed", "cancelled"]),
  planJson: z.unknown(),
  totalTasks: z.number(),
  completedTasks: z.number(),
  failedTasks: z.number(),
  maxParallelism: z.number(),
  outputFormat: z.enum(["json", "csv"]),
  resultUrl: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const workflowTaskSchema = z.object({
  id: z.string(),
  publicId: z.string(),
  workflowRunId: z.string(),
  taskIndex: z.number(),
  title: z.string(),
  goal: z.string(),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled"]),
  inngestRunId: z.string().nullable(),
  outputJson: z.unknown().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const workflowStatus = registerCapability({
  name: "get_workflow_status",
  domain: "workflow",
  description: "Read current status and task progress of a workflow run",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "workflow" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    workflowId: z
      .string()
      .min(1)
      .describe("Public ID (wfr_*) or internal UUID of the workflow run"),
  }),
  output: z.object({
    workflow: workflowRunSchema,
    tasks: z.array(workflowTaskSchema),
  }),
});

export type WorkflowStatusInput = z.output<typeof workflowStatus.input>;
export type WorkflowStatusOutput = z.output<typeof workflowStatus.output>;
export type WorkflowRunSnapshot = z.output<typeof workflowRunSchema>;
export type WorkflowTaskSnapshot = z.output<typeof workflowTaskSchema>;
