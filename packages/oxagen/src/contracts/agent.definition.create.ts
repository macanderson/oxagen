import { z } from "zod";
import { registerCapability } from "../registry";
import { avatarUrlSchema } from "../avatar";
import { graphAccessSchema, agentToolSchema } from "../agent-schema";

// The versioned body persisted into agent_versions.config. Mirrors
// agentDefinitionConfigSchema from agent-schema.ts so the contract input and
// the jsonb column never drift.
const definitionConfigInput = z.object({
  graph: graphAccessSchema,
  agentTools: z.array(agentToolSchema).default([]),
  instructions: z.string().optional(),
});

export const agentDefinitionCreate = registerCapability({
  name: "create_agent_def",
  domain: "agent",
  description:
    "Create a new agent definition — inserts the agent identity row (draft, inactive) and an immutable v1 version snapshot with the supplied, schema-validated config (graph access, tools, instructions)",
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
    slug: z
      .string()
      .max(
        18,
        "agent slugs are capped at 18 chars so the global agent key (org_ns.workspace_ns.slug, ≤6+6 namespaces) never exceeds 32",
      )
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase kebab-case"),
    name: z.string().min(1),
    description: z.string().optional(),
    agentType: z.string().default("custom"),
    // Optional avatar: an https:// URL or the designed-avatar spec string
    // ("avatar:v1:<json>"). Omit to leave the agent avatar unset.
    avatarUrl: avatarUrlSchema.optional(),
    config: definitionConfigInput,
  }),
  output: z.object({
    agentId: z.string(),
    publicId: z.string(),
    slug: z.string(),
    version: z.number().int().positive(),
  }),
});

export type AgentDefinitionCreateInput = z.output<
  typeof agentDefinitionCreate.input
>;
export type AgentDefinitionCreateOutput = z.output<
  typeof agentDefinitionCreate.output
>;
