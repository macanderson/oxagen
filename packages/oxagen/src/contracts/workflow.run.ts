import { z } from "zod";
import { registerCapability } from "../registry";

export const workflowRun = registerCapability({
  name: "run_workflow",
  domain: "workflow",
  description:
    "Decompose a large parallel goal into N sub-tasks, dispatch them concurrently via Inngest, and return a live progress component. Use for 10+ parallel data-gathering steps.",
  mode: "async",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "workflow" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    goal: z
      .string()
      .min(1)
      .max(2000)
      .describe("The overarching research or processing goal"),
    title: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Optional display title for the workflow"),
    outputFormat: z
      .enum(["json", "csv"])
      .default("json")
      .describe("Format for the aggregated result"),
    maxParallelism: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe("Maximum concurrent sub-tasks (1-100)"),
  }),
  output: z.object({
    workflowId: z
      .string()
      .describe(
        "Internal UUID of the agent_executions row (origin_type=workflow_run)",
      ),
    publicId: z
      .string()
      .describe("aex_* prefixed public ID of the agent_executions row"),
    status: z.literal("planning"),
    render: z.object({
      componentId: z.literal("workflow-progress"),
      props: z.object({ workflowId: z.string() }),
    }),
  }),
});

export type WorkflowRunInput = z.output<typeof workflowRun.input>;
export type WorkflowRunOutput = z.output<typeof workflowRun.output>;
