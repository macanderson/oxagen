import { z } from "zod";
import { registerCapability } from "../registry";

export const schemaReconcileDispatch = registerCapability({
  name: "dispatch_schema_reconcile",
  domain: "schema",
  description:
    "Dispatch an async reconciliation job to re-label existing graph nodes and relationships against the pinned schema version.",
  mode: "async",
  surfaces: ["api", "mcp", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "schema" },
  sensitivity: "destructive",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    versionId: z.string().min(1),
    prune: z.boolean().default(false),
  }),
  output: z.object({
    executionId: z.string().describe("aex_… agent_executions public_id"),
  }),
});

export type SchemaReconcileDispatchInput = z.output<
  typeof schemaReconcileDispatch.input
>;
export type SchemaReconcileDispatchOutput = z.output<
  typeof schemaReconcileDispatch.output
>;
