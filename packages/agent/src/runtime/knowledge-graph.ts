import type { CoreMessage } from "ai";
import type { CapabilityContext } from "../types.js";

/**
 * A single context block surfaced from the knowledge graph to be injected
 * into the agent's message context before the LLM call.
 */
export interface ContextBlock {
  source: string;
  text: string;
}

/**
 * Returns true only when Neo4j env is fully configured AND the feature flag
 * KNOWLEDGE_GRAPH_ENABLED is not explicitly set to "false".
 *
 * Default is OFF — the app must be stable with no Neo4j wiring.
 */
export function isKnowledgeGraphEnabled(): boolean {
  if (process.env.KNOWLEDGE_GRAPH_ENABLED === "false") return false;
  const uri = process.env.NEO4J_URI;
  return typeof uri === "string" && uri.length > 0;
}

/**
 * Read workspace-scoped context blocks from the knowledge graph.
 *
 * When the knowledge graph is disabled (default), returns [] immediately
 * without touching Neo4j or performing any I/O.
 *
 * When enabled — TODO(knowledge-graph): wire real KG context query here.
 * The seam exists so callers in the chat path don't need to change when
 * we implement the full read (OXA-next).
 */
export async function readWorkspaceContext(
  ctx: Pick<CapabilityContext, "orgId" | "workspaceId"> & { userId: string | null },
): Promise<ContextBlock[]> {
  if (!isKnowledgeGraphEnabled()) {
    return [];
  }
  // TODO(knowledge-graph): query Neo4j for workspace-level context nodes
  // relevant to this org/workspace and prepend them to the conversation.
  // Return [] for now even when enabled; this stub lets the feature-flag
  // infrastructure and injection path be exercised before the graph query
  // is implemented.
  void ctx; // suppress unused-variable lint until the TODO is wired
  return [];
}

/**
 * Prepend a single system message built from `blocks` to `messages`.
 *
 * When `blocks` is empty the original array is returned unchanged — a
 * true no-op so callers pay zero allocation cost today.
 */
export function injectContext(messages: CoreMessage[], blocks: ContextBlock[]): CoreMessage[] {
  if (blocks.length === 0) return messages;
  const contextText = blocks.map((b) => `[${b.source}]\n${b.text}`).join("\n\n");
  const systemBlock: CoreMessage = {
    role: "system",
    content: contextText,
  };
  return [systemBlock, ...messages];
}
