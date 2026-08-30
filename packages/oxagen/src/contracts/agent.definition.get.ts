import { z } from "zod";
import { registerCapability } from "../registry";
import { agentDefinitionConfigSchema } from "../agent-schema";

export const agentDefinitionGet = registerCapability({
  name: "get_agent_def",
  domain: "agent",
  description:
    "Fetch an agent definition with its active (or latest) version config, parsed and validated via parseAgentDefinitionConfig",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
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
    agentKey: z
      .string()
      .nullable()
      .describe(
        "Globally-unique, immutable, human-readable agent identifier: org_namespace.workspace_namespace.agent_slug (≤32 chars for agents created after namespaces shipped). Null only if the org/workspace namespace has not been backfilled yet.",
      ),
    name: z.string(),
    description: z.string().nullable(),
    // Nullable avatar: an https:// URL or a designed-avatar spec string
    // ("avatar:v1:<json>"). Null when the agent has no avatar set.
    avatarUrl: z.string().nullable(),
    // LLM-inferred, plain-text (<=256 char) description of what the agent does.
    // Null until agent.definition.summarize has run for the agent.
    summary: z.string().nullable(),
    agentType: z.string(),
    status: z.enum(["draft", "active", "archived"]),
    deploymentStatus: z.enum(["inactive", "active"]),
    version: z.number().int().positive().nullable(),
    isPublished: z.boolean(),
    managed: z
      .boolean()
      .describe(
        "True for product-managed (built-in) agents that are read-only to customers — viewable but not editable, publishable, deployable, or trigger-configurable",
      ),
    config: agentDefinitionConfigSchema,
  }),
});

export type AgentDefinitionGetInput = z.output<typeof agentDefinitionGet.input>;
export type AgentDefinitionGetOutput = z.output<
  typeof agentDefinitionGet.output
>;
