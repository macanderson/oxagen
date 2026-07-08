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
        agentKey: z
          .string()
          .nullable()
          .describe(
            "Globally-unique, immutable agent identifier: org_namespace.workspace_namespace.agent_slug (≤32 chars for agents created after namespaces shipped). Null only pre-backfill.",
          ),
        name: z.string(),
        description: z.string().nullable(),
        /**
         * The agent's type discriminator (free-form; e.g. `custom`,
         * `interactive_chat`, or `code`). Surfaced so callers — notably the
         * app's new-session agent selector — can classify a code agent
         * (`agentType === "code"`, see isCodeAgentType) and gate the repo/code
         * tooling + UI accordingly.
         */
        agentType: z.string(),
        status: z.enum(["draft", "active", "archived"]),
        deploymentStatus: z.enum(["inactive", "active"]),
        latestVersion: z.number().int().nullable(),
        managed: z
          .boolean()
          .describe(
            "True for product-managed (built-in) agents that are read-only to customers — viewable but not editable, publishable, deployable, or trigger-configurable",
          ),
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
