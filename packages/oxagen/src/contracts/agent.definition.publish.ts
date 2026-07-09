import { z } from "zod";
import { registerCapability } from "../registry";

export const agentDefinitionPublish = registerCapability({
  name: "publish_agent_def",
  domain: "agent",
  description:
    "Publish an agent version — marks it isPublished, computes a SHA-256 checksum over its canonical config, and sets it as the agent's active version. A published version is immutable thereafter",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "medium", category: "mutation" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    agentId: z.string().describe("Agent public id (agt_…) or UUID"),
    version: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Version number to publish. Omit to publish the latest."),
  }),
  output: z.object({
    agentId: z.string(),
    version: z.number().int().positive(),
    checksum: z.string(),
    activeVersionId: z.string(),
  }),
});

export type AgentDefinitionPublishInput = z.output<
  typeof agentDefinitionPublish.input
>;
export type AgentDefinitionPublishOutput = z.output<
  typeof agentDefinitionPublish.output
>;
