import { z } from "zod";
import { registerCapability } from "../registry";
import { avatarUrlSchema } from "../avatar";
import { graphAccessSchema, agentToolSchema } from "../agent-schema";

const definitionConfigInput = z.object({
  graph: graphAccessSchema,
  agentTools: z.array(agentToolSchema).default([]),
  instructions: z.string().optional(),
});

export const agentDefinitionUpdate = registerCapability({
  name: "update_agent_def",
  domain: "agent",
  description:
    "Update an agent definition by snapshotting a NEW unpublished version with the updated config — published versions are immutable and never edited in place; the version number is bumped",
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
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    // Optional identity-row change. Workbench persists the "code features" toggle
    // as agentType ("coding" on / "custom" off), so editing an existing agent
    // must be able to flip it. Omitted → the agentType is left unchanged.
    agentType: z.string().optional(),
    // Optional avatar change. Omit = unchanged, a value = set (https:// URL or an
    // "avatar:v1:<json>" designed-avatar string), null = clear the avatar.
    avatarUrl: avatarUrlSchema.nullable().optional(),
    config: definitionConfigInput,
  }),
  output: z.object({
    agentId: z.string(),
    version: z.number().int().positive(),
    isPublished: z.boolean(),
  }),
});

export type AgentDefinitionUpdateInput = z.output<
  typeof agentDefinitionUpdate.input
>;
export type AgentDefinitionUpdateOutput = z.output<
  typeof agentDefinitionUpdate.output
>;
