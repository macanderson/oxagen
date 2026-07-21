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

// The three system agent roles (Agent RBAC, docs/specs/agent-rbac/spec.md
// §3.2). Restated as literals rather than imported from
// @oxagen/handlers/lib/agent-role-defaults because the contract layer must not
// depend on the handler layer — the dependency runs handlers → contracts. The
// SUGGESTION LOGIC still lives handler-side and is derived from
// AGENT_ROLE_SPECS; this enum only constrains the wire shape. Deliberately
// excludes "Agent Legacy (unrestricted)", which is backfill-only and must
// never be proposed for a new agent.
const suggestedRoleNameSchema = z.enum([
  "Agent Observer",
  "Agent Contributor",
  "Agent Operator",
]);

export const agentDefinitionSuggest = registerCapability({
  name: "suggest_agent_def",
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
        "Tools the agent SHOULD have that are not yet available in the workspace — MCP servers from the catalog that are not registered, or disabled skills. Never included in suggestion.config.agentTools (which only carries refs that exist right now); the caller connects/enables these first, then equips them. The suggested IAM role for the same draft is returned separately as `suggestedRole` (docs/specs/agent-rbac).",
      ),
    // ADDITIVE (Agent RBAC Phase 5b). Optional so every existing consumer of
    // this contract is unaffected: a caller that ignores the field behaves
    // exactly as before, and a handler build that does not emit it still
    // passes the kernel's output validation.
    suggestedRole: z
      .object({
        roleName: suggestedRoleNameSchema.describe(
          "The narrowest system agent role that can still run this draft.",
        ),
        reason: z
          .string()
          .min(1)
          .describe(
            "Why this role and not a narrower one — cites the equipped capabilities, MCP servers, or graph-write request that a smaller ceiling would block.",
          ),
      })
      .optional()
      .describe(
        "Suggested ROLE (the ceiling) for the drafted definition (the request); effective scope is the intersection of the two. Derived deterministically in code from the drafted config's capability category/riskLevel metadata and the system roles' own grant mapping — NOT model output. Advisory only: a pre-selection for a human-reviewable picker. assign_agent_role remains the sole authority (delegation ceiling, tier gate, assignability), and a caller that omits this field falls back to 'Agent Contributor'.",
      ),
  }),
});

export type AgentDefinitionSuggestInput = z.output<
  typeof agentDefinitionSuggest.input
>;
export type AgentDefinitionSuggestOutput = z.output<
  typeof agentDefinitionSuggest.output
>;
