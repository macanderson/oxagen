import { z } from "zod";
import { registerCapability } from "../registry";

export const schemaReconcileStatus = registerCapability({
  name: "get_reconcile_status",
  domain: "schema",
  description: "Poll the status of a schema reconciliation job.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "schema" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    executionId: z.string().min(1).describe("aex_… agent_executions public_id"),
  }),
  output: z.object({
    status: z.enum(["planning", "running", "completed", "failed", "cancelled"]),
    totalNodes: z.number(),
    processedNodes: z.number(),
    updatedNodes: z.number(),
    totalRelationships: z.number(),
    processedRelationships: z.number(),
    updatedRelationships: z.number(),
    prunedNodes: z.number(),
    prunedRelationships: z.number(),
  }),
});

export type SchemaReconcileStatusInput = z.output<
  typeof schemaReconcileStatus.input
>;
export type SchemaReconcileStatusOutput = z.output<
  typeof schemaReconcileStatus.output
>;
