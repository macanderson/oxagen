import { z } from "zod";
import { registerCapability } from "../registry";
import {
  graphAccessSchema,
  agentToolSchema,
  agentTriggerSchema,
} from "../agent-schema";

// The suggested versioned body. Mirrors agentDefinitionConfigSchema (and the
// agent.definition.create input) so a suggestion can be fed straight into
// agent.definition.create without reshaping. `instructions` is required here —
// a suggestion without a system prompt is not a usable starting point.
const suggestedConfigSchema = z.object({
  graph: graphAccessSchema,
  agentTools: z.array(agentToolSchema).default([]),
  triggers: z.array(agentTriggerSchema).default([]),
  instructions: z.string().min(1),
});

export const agentDefinitionSuggest = registerCapability({
  name: "agent.definition.suggest",
  domain: "agent",
  description:
    "AI-assisted agent setup: turn a plain-language description of what an agent should do into a complete draft agent configuration (identity, instructions, graph access, tools, triggers), grounded in the workspace's real skills, ontologies, MCP servers, and capabilities via the create-agent skill. Returns a suggestion shaped exactly like agent.definition.create input, plus a rationale and any warnings — nothing is persisted; the caller reviews, edits, and saves the draft explicitly.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    description: z
      .string()
      .min(10)
      .max(4000)
      .describe(
        "Plain-language description of what the agent should do — its job, what should start it, and what it may touch. At least 10 characters.",
      ),
    nameHint: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase kebab-case")
      .optional()
      .describe(
        "Optional preferred slug (kebab-case). The model derives one from the description if omitted.",
      ),
    agentTypeHint: z
      .string()
      .optional()
      .describe(
        'Optional agentType to steer toward (e.g. "code" for a repo-capable agent). The model infers it from the description if omitted.',
      ),
  }),
  output: z.object({
    suggestion: z
      .object({
        slug: z
          .string()
          .max(
            18,
            "agent slugs are capped at 18 chars so the global agent key (org_ns.workspace_ns.slug) never exceeds 32",
          )
          .regex(
            /^[a-z0-9]+(-[a-z0-9]+)*$/,
            "slug must be lowercase kebab-case",
          ),
        name: z.string().min(1),
        description: z.string().min(1),
        agentType: z.string().default("custom"),
        config: suggestedConfigSchema,
      })
      .describe(
        "A complete agent configuration, shaped exactly like agent.definition.create input. Every field is a reviewable suggestion — the caller may edit anything before saving.",
      ),
    rationale: z
      .string()
      .describe(
        "Why the model chose this configuration — instructions framing, tool selection, graph scoping, and trigger choice.",
      ),
    warnings: z
      .array(z.string())
      .default([])
      .describe(
        "Non-fatal adjustments made during validation, e.g. a suggested tool ref that does not exist in the workspace and was removed.",
      ),
    recommendations: z
      .array(
        z.object({
          kind: z
            .enum(["mcp_server", "skill"])
            .describe(
              "What kind of thing to connect: an MCP server from the synced registry catalog, or a workspace skill that exists but is disabled.",
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
              "Why this agent needs it, phrased against the user's description (e.g. 'watches PRs for schema changes — needs GitHub access').",
            ),
        }),
      )
      .default([])
      .describe(
        "Tools the agent SHOULD have that are not yet available in the workspace — MCP servers from the catalog that are not registered, or disabled skills. Never included in suggestion.config.agentTools (which only carries refs that exist right now); the caller connects/enables these first, then equips them. A seam for suggested IAM roles will join this once agent RBAC ships (docs/specs/agent-rbac).",
      ),
  }),
});

export type AgentDefinitionSuggestInput = z.output<
  typeof agentDefinitionSuggest.input
>;
export type AgentDefinitionSuggestOutput = z.output<
  typeof agentDefinitionSuggest.output
>;
