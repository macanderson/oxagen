import { z } from "zod";
import { registerCapability } from "../registry";
import { agentToolTypeSchema } from "../agent-schema";

export const agentDefinitionList = registerCapability({
  name: "list_agent_defs",
  domain: "agent",
  description:
    "List the agent definitions in the current workspace with their identity, lifecycle status, deployment posture, and latest version number",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  // Read-only introspection: consumes no AI tokens, so a zero-credit or
  // dunning-suspended org can still SEE its automations (running them is
  // still gated). Without this the trigger board cannot even load.
  noBillingGate: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  mutates: false,
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
        // Nullable avatar: an https:// URL or a designed-avatar spec string
        // ("avatar:v1:<json>"). Null when the agent has no avatar set.
        avatarUrl: z.string().nullable(),
        // LLM-inferred, plain-text (<=256 char) description of what the agent
        // does. Null until agent.definition.summarize has run for the agent.
        summary: z.string().nullable(),
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
        /**
         * Refs (type + ref only, never the config payloads) of everything the
         * agent loads — functions, MCP servers, skills, subagents — taken from
         * the config of its active version (or latest, when unpublished). Lets
         * the app's agent picker render skill/tool chips per agent without an
         * N+1 of get_agent_def calls. Empty when the agent loads nothing (or its
         * config is absent/malformed). Refs-only by design: NOT the per-tool
         * config (MCP auth, skill pins, subagent budgets) — fetch that via
         * get_agent_def when a detail view needs it.
         */
        toolRefs: z
          .array(
            z.object({
              type: agentToolTypeSchema,
              ref: z.string(),
            }),
          )
          .default([]),
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
