import { z } from "zod";
import { registerCapability } from "../registry";
import { agentDefinitionConfigSchema } from "../agent-schema";

export const agentDefinitionGet = registerCapability({
  name: "agent.definition.get",
  domain: "agent",
  description:
    "Fetch an agent definition with its active (or latest) version config, parsed and validated via parseAgentDefinitionConfig",
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
    agentId: z.string().describe("Agent public id (agt_…), UUID, or slug"),
  }),
  output: z.object({
    agentId: z.string(),
    publicId: z.string(),
    slug: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    agentType: z.string(),
    status: z.enum(["draft", "active", "archived"]),
    deploymentStatus: z.enum(["inactive", "active"]),
    version: z.number().int().positive().nullable(),
    isPublished: z.boolean(),
    config: agentDefinitionConfigSchema,
  }),
});

export type AgentDefinitionGetInput = z.output<typeof agentDefinitionGet.input>;
export type AgentDefinitionGetOutput = z.output<
  typeof agentDefinitionGet.output
>;
