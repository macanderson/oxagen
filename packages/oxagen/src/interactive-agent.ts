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
 * The capabilities the in-app assistant pins, also granted as `function`
 * agentTools in the published config. The provider sees these seven, plus
 * `search_tools` and `load_tools`, on every turn. Every other capability on
 * the `agent` surface stays reachable through those two meta-tools. A pin
 * costs tokens on every turn (#2611), so each one answers a question people
 * ask in the flyout, from the same read the rev1 page uses:
 *
 * - `list_runs`: what the workspace's agents ran, from the Fleet table.
 * - `get_run`: what one run did, frame by frame, from the Run page.
 * - `get_run_cost`: what one run cost, by model and token class.
 * - `get_spend`: what the workspace spent, by operator, agent, model, tool,
 *   task or cost center.
 * - `list_approvals`: which tool calls wait on a person.
 * - `list_agents`: which agents exist, their status and 30-day figures.
 * - `search_graph`: the way into the workspace knowledge graph. It finds
 *   nodes by meaning. `query_ontology` and `get_ontology_neighbors` start
 *   from a node id, so neither can answer first. Both stay one `load_tools`
 *   call away.
 *
 * Every pin is a read the assistant may call without a person: it declares
 * `mutates: false`, low risk and no approval (interactive-agent.test.ts).
 * That rules out `recall_memory`, which raises the confidence score of every
 * memory it returns. Each turn already recalls workspace memory before the
 * model runs (packages/agent/src/runtime/assistant-recall.ts).
 * `list_executions` and `get_execution_trace` read the legacy
 * `agent_executions` store. `list_runs` and `get_run` read the fleet record
 * the rev1 pages show, so they replace those two here.
 *
 * Every entry is a registered capability name (ADR-025 verb-first
 * snake_case), so each call still passes the kernel's IAM, entitlement and
 * metering gates. ADR-043 replaced the previous skill list here: a governed
 * agent's grant names things the platform can gate, not prompt fragments.
 */
export const INTERACTIVE_AGENT_CAPABILITIES = [
  "list_runs",
  "get_run",
  "get_run_cost",
  "get_spend",
  "list_approvals",
  "list_agents",
  "search_graph",
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
      "You answer questions about this workspace's agents: what they ran, " +
      "what it cost, which tool calls wait on approval, and which agents " +
      "exist. You also answer questions about the workspace knowledge graph. " +
      "Ground every claim in a tool result and name each record by its human " +
      "label. When no tool result supports an answer, say so. When a question " +
      "needs a tool you do not hold, find it with search_tools and load it " +
      "with load_tools. Oxagen governs agents and records what they do. It " +
      "does not run them.",
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
