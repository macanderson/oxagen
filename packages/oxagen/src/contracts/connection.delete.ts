import { z } from "zod";
import { registerCapability } from "../registry";

export const connectionDelete = registerCapability({
  name: "delete_connection",
  domain: "connection",
  description:
    "Delete a data source connection. Supports three modes: connection_only (revoke auth, keep data), data_only (delete Neo4j data, keep config), or full (delete everything).",
  mode: "async",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "destructive" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    connectionId: z
      .string()
      .min(1)
      .describe("Public ID or internal UUID of the connection"),
    mode: z
      .enum(["connection_only", "data_only", "full"])
      .default("full")
      .describe(
        "connection_only: revoke auth + stop ingestion, keep Neo4j data. data_only: delete Neo4j data, keep connection. full: delete everything.",
      ),
  }),
  output: z.object({
    deletionJobId: z
      .string()
      .describe("Public ID of the deletion_jobs row tracking async progress"),
    mode: z.enum(["connection_only", "data_only", "full"]),
    status: z.literal("running"),
  }),
});

export type ConnectionDeleteInput = z.output<typeof connectionDelete.input>;
export type ConnectionDeleteOutput = z.output<typeof connectionDelete.output>;
