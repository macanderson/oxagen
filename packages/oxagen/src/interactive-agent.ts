import { createHash } from "node:crypto";
import {
  agentDefinitionConfigSchema,
  type AgentDefinitionConfig,
} from "./agent-schema";

// ─────────────────────────────────────────────────────────────────────────────
// Interactive agent — the single source of truth for the `qa-chat` agent that
// backs BOTH the MCP server and the in-app governance Q&A surface. It is a
// read-and-explain agent over the fleet record and the knowledge graph; it has
// no execution surface of its own (ADR-043). The seeder script and
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

/**
 * True when an agent's `agentType` marks it as a product-managed (built-in)
 * agent — currently the interactive `qa-chat` agent. Product-managed agents are
 * bootstrapped into every workspace and are READ-ONLY to customers: they may be
 * viewed but never edited, published, deployed, or archived. Enforced at the
 * capability-handler layer (so the API, MCP, and app surfaces all honor it) and
 * surfaced as `managed` on agent list/get outputs so the UI can render them
 * clearly as non-configurable.
 */
export function isManagedAgentType(agentType: string): boolean {
  return agentType === INTERACTIVE_AGENT_TYPE;
}

/** Stable error code thrown when a mutation targets a product-managed agent. */
export const MANAGED_AGENT_READONLY_CODE = "agent_managed_read_only";

/**
 * The capability allowlist the interactive agent is granted, as `function`
 * agentTools. These are the governed reads that let it answer "what did my
 * agents do, what grounded them, what is pending" — the graph and ontology
 * read set, the execution record, and its own memory. Every entry is a
 * registered capability name (ADR-025 verb-first snake_case), so each call
 * still passes the kernel's IAM, entitlement and metering gates.
 *
 * ADR-043 replaced the previous skill list here: skills no longer exist, and a
 * governed agent's grant is an allowlist of things the platform can gate, not
 * a bundle of prompt fragments.
 */
export const INTERACTIVE_AGENT_CAPABILITIES = [
  "query_ontology",
  "get_ontology_neighbors",
  "recall_memory",
  "save_memory",
  "cite_reference",
  "list_executions",
  "get_execution_trace",
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
    agentTools: INTERACTIVE_AGENT_CAPABILITIES.map((name) => ({
      type: "function",
      ref: name,
    })),
    instructions:
      "You are the workspace governance and Q&A agent. Answer questions about " +
      "this workspace's agents — what they did, what context grounded them, " +
      "what they cost, what is pending approval — and about the workspace " +
      "knowledge graph. Ground every claim in a tool result and cite the nodes " +
      "you used by their human label. When you lack grounding, say so rather " +
      "than guessing. You do not run, deploy, or edit anything: Oxagen governs " +
      "agents, it does not execute them.",
  });
}

/**
 * Compute the immutable SHA-256 checksum for a version config. Used at publish
 * time so a published version's body can be proven unmodified. Keys are sorted
 * so logically-equal configs hash identically regardless of property order.
 */
export function computeConfigChecksum(config: unknown): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
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
