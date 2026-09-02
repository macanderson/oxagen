import { z } from "zod";
import { registerCapability } from "../registry";

export const workflowCancel = registerCapability({
  name: "cancel_workflow",
  domain: "workflow",
  description:
    "Cancel a running or planning workflow, stopping all in-flight sub-tasks",
  mode: "sync",
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
    workflowId: z
      .string()
      .min(1)
      .describe("Public ID (wfr_*) or internal UUID of the workflow run"),
  }),
  output: z.object({
    cancelled: z.boolean(),
  }),
});

export type WorkflowCancelInput = z.output<typeof workflowCancel.input>;
export type WorkflowCancelOutput = z.output<typeof workflowCancel.output>;
