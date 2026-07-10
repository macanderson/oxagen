import { z } from "zod";
import { registerCapability } from "../registry";

export const agentDefinitionSummarize = registerCapability({
  name: "summarize_agent_def",
  domain: "agent",
  description:
    "Generate (or refresh) a short, LLM-inferred plain-text summary of what an agent does, derived from its name, instructions, equipped tools, and triggers. The summary is cached against a checksum of the agent's current config: it is only regenerated when the config has changed since the last summary, or when `force` is set. Returns the summary and the checksum it was derived from.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "mutation" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    agentId: z
      .string()
      .describe("Agent public id (agt_…), UUID, or slug — workspace-scoped."),
    force: z
      .boolean()
      .optional()
      .describe(
        "Regenerate even when a summary already exists and its checksum still matches the current config. Defaults to false (return the cached summary on a checksum match).",
      ),
  }),
  output: z.object({
    agentId: z.string().describe("The agent's public id (agt_…)."),
    summary: z
      .string()
      .describe(
        "Plain-text (<=256 char) description of what the agent does and what it works with. No markdown, no quotes.",
      ),
    checksum: z
      .string()
      .describe(
        "SHA-256 of the canonical version config this summary was derived from. Detects staleness on the next call.",
      ),
  }),
});

export type AgentDefinitionSummarizeInput = z.output<
  typeof agentDefinitionSummarize.input
>;
export type AgentDefinitionSummarizeOutput = z.output<
  typeof agentDefinitionSummarize.output
>;
