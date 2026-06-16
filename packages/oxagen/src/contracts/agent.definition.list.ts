import { z } from "zod";
import { registerCapability } from "../registry";

export const agentDefinitionList = registerCapability({
  name: "agent.definition.list",
  domain: "agent",
  description:
    "List the agent definitions in the current workspace with their identity, lifecycle status, deployment posture, and latest version number",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "introspection" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    status: z
      .enum(["draft", "active", "archived"])
      .optional()
      .describe("Filter by lifecycle status"),
  }),
  output: z.object({
    agents: z.array(
      z.object({
        agentId: z.string(),
        publicId: z.string(),
        slug: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        status: z.enum(["draft", "active", "archived"]),
        deploymentStatus: z.enum(["inactive", "active"]),
        latestVersion: z.number().int().nullable(),
      }),
    ),
  }),
});

export type AgentDefinitionListInput = z.output<
  typeof agentDefinitionList.input
>;
export type AgentDefinitionListOutput = z.output<
  typeof agentDefinitionList.output
>;
