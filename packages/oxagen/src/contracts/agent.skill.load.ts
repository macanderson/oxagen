import { z } from "zod";
import { registerCapability } from "../registry";

export const agentSkillLoad = registerCapability({
  name: "load_skill",
  domain: "agent",
  description:
    "Load and register a workspace skill at runtime — resolves the requested version, validates dependencies, and returns the skill body and available capabilities",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
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
    skillSlug: z.string(),
    version: z
      .string()
      .optional()
      .describe(
        "Version constraint: exact integer (e.g. '3'), caret ('^2' = latest ≥2.x), or tilde ('~2' = latest 2.x patch). Omit for latest.",
      ),
    dependencies: z
      .array(z.string())
      .optional()
      .describe("Additional skill slugs to pre-validate alongside this one"),
  }),
  output: z.object({
    skillSlug: z.string(),
    loaded: z.boolean(),
    versionLoaded: z.number(),
    body: z.string(),
    capabilities: z.array(z.string()),
    dependencyErrors: z.array(
      z.object({ slug: z.string(), reason: z.string() }),
    ),
  }),
});

export type AgentSkillLoadInput = z.output<typeof agentSkillLoad.input>;
export type AgentSkillLoadOutput = z.output<typeof agentSkillLoad.output>;
