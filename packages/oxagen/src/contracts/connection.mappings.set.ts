import { z } from "zod";
import { registerCapability } from "../registry";

export const connectionMappingsSet = registerCapability({
  name: "set_connection_mappings",
  domain: "connection",
  description:
    "Save entity type mappings for a data source connection. Activates the connection and starts ingestion once mappings are confirmed.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "write" },
  sensitivity: "medium",
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
    mappings: z
      .array(
        z.object({
          sourceRecordType: z.string().min(1),
          oxagenEntityType: z
            .string()
            .min(1)
            .describe("Target entity type string (snake_case)"),
          propertyMappings: z
            .record(z.string())
            .default({})
            .describe("Source field path → canonical property name"),
        }),
      )
      .min(1)
      .describe("Confirmed entity type mappings to save"),
    activateConnection: z
      .boolean()
      .default(true)
      .describe(
        "If true, sets connection status to active and queues initial sync after saving mappings",
      ),
    // GitHub-specific delivery config fields. The wizard sends these so the
    // handler can persist them into source_connections.deliveryConfig before
    // firing the ingestion event. Zod strips unknown keys by default, so
    // they must be declared here or they never reach the handler.
    installationId: z
      .string()
      .optional()
      .describe("GitHub App installation ID"),
    selectedRepos: z
      .array(z.string())
      .optional()
      .describe("Fully-qualified repo names selected by the user (owner/repo)"),
    syncDepthDays: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("How many days of git history to include in the initial sync"),
    owner: z
      .string()
      .optional()
      .describe("GitHub org or user login (derived from selectedRepos[0])"),
    repo: z
      .string()
      .optional()
      .describe(
        "Repository name without owner (derived from selectedRepos[0])",
      ),
    defaultBranch: z
      .string()
      .optional()
      .describe("Default branch of the primary repository (e.g. 'main')"),
  }),
  output: z.object({
    mappingsCreated: z.number(),
    mappingsUpdated: z.number(),
    connectionStatus: z.string(),
  }),
});

export type ConnectionMappingsSetInput = z.output<
  typeof connectionMappingsSet.input
>;
export type ConnectionMappingsSetOutput = z.output<
  typeof connectionMappingsSet.output
>;
