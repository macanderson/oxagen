import { z } from "zod";
import { registerCapability } from "../registry";

// The connect-first recommendation shape — identical to agent.definition.suggest.
// Tools the revised agent SHOULD have but that are not available in the
// workspace yet (a catalog MCP server to connect, a disabled skill to enable).
const recommendationSchema = z.object({
  kind: z
    .enum(["mcp_server", "skill"])
    .describe(
      "What to connect: an MCP server from the synced registry catalog, or a workspace skill that exists but is disabled.",
    ),
  ref: z
    .string()
    .describe(
      "Catalog identity for an mcp_server (registry server name, e.g. 'github/github-mcp-server') or the skill slug for a skill.",
    ),
  name: z.string().describe("Human-readable display name."),
  reason: z
    .string()
    .describe(
      "Why the revised agent needs it, phrased against the revision request.",
    ),
});

export const agentDefinitionRevise = registerCapability({
  name: "revise_agent_def",
  domain: "agent",
  description:
    "AI-driven edit of an existing agent definition: take a plain-language description of the change you want and the agent's current config, have the model design the revised configuration (identity, instructions, graph access, tools, triggers) grounded in the workspace's real skills, ontologies, MCP servers, and capabilities, then persist it as a NEW unpublished version — the version number is bumped. The agent's immutable slug never changes, and publishing stays a separate explicit step, so a revision never silently changes what is live. Returns the new version, a rationale, a human-readable change summary, any validation warnings, and connect-first recommendations.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "medium", category: "mutation" },
  sensitivity: "medium",
  defaultEffect: "deny",
  // Mirrors agent.definition.update — the persist path this composes onto.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    agentId: z
      .string()
      .describe(
        "Agent public id (agt_…), UUID, or slug of the agent to revise.",
      ),
    prompt: z
      .string()
      .min(10)
      .max(4000)
      .describe(
        "Plain-language description of the change to make — e.g. 'give it read access to the billing ontology and equip the github MCP server'. At least 10 characters.",
      ),
  }),
  output: z.object({
    agentId: z.string().describe("Public id (agt_…) of the revised agent."),
    version: z
      .number()
      .int()
      .positive()
      .describe("The newly-created (bumped) version number."),
    isPublished: z
      .boolean()
      .describe(
        "Always false — revise snapshots a new unpublished version; publish is a separate step.",
      ),
    rationale: z
      .string()
      .describe(
        "Why the model made these changes — instructions framing, tool selection, graph scoping, trigger choice.",
      ),
    changeSummary: z
      .array(z.string())
      .default([])
      .describe(
        "Short human-readable bullets of what changed versus the prior version, for a diff line in the UI.",
      ),
    warnings: z
      .array(z.string())
      .default([])
      .describe(
        "Non-fatal adjustments made during validation, e.g. a suggested tool ref that does not exist in the workspace and was removed.",
      ),
    recommendations: z
      .array(recommendationSchema)
      .default([])
      .describe(
        "Tools the revised agent SHOULD have that are not yet available in the workspace — catalog MCP servers to connect, or disabled skills to enable. Never equipped automatically; the caller connects/enables them first, then revises again to equip them.",
      ),
  }),
});

export type AgentDefinitionReviseInput = z.output<
  typeof agentDefinitionRevise.input
>;
export type AgentDefinitionReviseOutput = z.output<
  typeof agentDefinitionRevise.output
>;
