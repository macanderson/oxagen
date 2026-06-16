import { createHash } from "node:crypto";
import {
  agentDefinitionConfigSchema,
  type AgentDefinitionConfig,
} from "./agent-schema";

// ─────────────────────────────────────────────────────────────────────────────
// Interactive agent — the single source of truth for the `qa-chat` agent that
// backs BOTH the MCP server and the in-app Q&A surface. The seeder script and
// the workspace-creation bootstrap both build their published v1 config from
// here so the chat.stream lookup (slug "qa-chat") always resolves to a fully
// schema-conforming, published definition.
// ─────────────────────────────────────────────────────────────────────────────

/** Well-known slug the in-app chat (chat.stream) and MCP server resolve. */
export const INTERACTIVE_AGENT_SLUG = "qa-chat";

/** Display name for the interactive agent. */
export const INTERACTIVE_AGENT_NAME = "QA Chat Agent";

/** agentType discriminator on the `agents` row. */
export const INTERACTIVE_AGENT_TYPE = "interactive_chat";

/** Human description shown in selectors and the agents list. */
export const INTERACTIVE_AGENT_DESCRIPTION =
  "Interactive question-answering agent grounded in the workspace knowledge graph. Backs the in-app Q&A surface and the MCP server.";

/** The builtin skills the interactive agent loads as agentTools (type "skill").
 *  These mirror the slugs seeded by `pnpm db:seed-skills`. */
export const INTERACTIVE_AGENT_SKILLS = [
  "coding",
  "debugging",
  "summarization",
  "skill-builder",
  "agent-builder",
] as const;

/**
 * Build the canonical interactive-agent config for a workspace, bound to the
 * supplied ontology. Validated through agentDefinitionConfigSchema so a malformed
 * config can never be persisted.
 *
 * @param ontologyId the ontology this workspace's interactive agent reasons over.
 *   Defaults to the workspace id, which is the per-workspace ontology convention.
 */
export function buildInteractiveAgentConfig(
  ontologyId: string,
): AgentDefinitionConfig {
  return agentDefinitionConfigSchema.parse({
    graph: {
      ontologyId,
      mode: "read",
      retrieval: { strategy: "hybrid" },
      budget: { maxHops: 3, maxNodes: 50, minRelevance: 0.5 },
    },
    agentTools: INTERACTIVE_AGENT_SKILLS.map((slug) => ({
      type: "skill",
      ref: slug,
    })),
    triggers: [{ type: "manual", enabled: true }],
    instructions:
      "You are the workspace Q&A agent. Answer questions grounded strictly in " +
      "the workspace knowledge graph. Cite the nodes you used. When you lack " +
      "grounding, say so rather than guessing. Use your loaded skills (coding, " +
      "debugging, summarization) to shape responses, and defer structural or " +
      "agent-authoring requests to the skill-builder and agent-builder skills.",
  });
}

/**
 * Compute the immutable SHA-256 checksum for a version config. Used at publish
 * time so a published version's body can be proven unmodified. Keys are sorted
 * so logically-equal configs hash identically regardless of property order.
 */
export function computeConfigChecksum(config: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(config))
    .digest("hex");
}

/** Deterministic JSON: object keys sorted recursively. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}
