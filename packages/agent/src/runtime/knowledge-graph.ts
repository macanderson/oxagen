import type { ModelMessage } from "ai";
import pino from "pino";
import type { CapabilityContext } from "../types";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info", base: { app: "agent.knowledge-graph" } });

// Fire the OXA-1508 warn at most once per process to avoid log noise on every turn.
let _warnedOxa1508 = false;

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
 * When enabled but the workspace-context query is not yet wired (OXA-1508),
 * logs once at warn level and returns []. This is intentionally honest about
 * the unimplemented state — callers should not rely on non-empty results until
 * the real Cypher query ships.
 */
export async function readWorkspaceContext(
  ctx: Pick<CapabilityContext, "orgId" | "workspaceId"> & { userId: string | null },
): Promise<ContextBlock[]> {
  if (!isKnowledgeGraphEnabled()) {
    return [];
  }
  // Knowledge-graph is enabled (NEO4J_URI is set) but the workspace-context
  // Cypher query is not yet implemented (OXA-1508). Log clearly so operators
  // know the graph is reachable but context injection is dormant, then return
  // an empty set — no silent fake data, no crash.
  if (!_warnedOxa1508) {
    _warnedOxa1508 = true;
    logger.warn(
      { oxa: "OXA-1508", orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "readWorkspaceContext — KG enabled but workspace-context query not yet wired; returning [] until OXA-1508 is resolved",
    );
  }
  return [];
}

/**
 * Prepend a single system message built from `blocks` to `messages`.
 *
 * When `blocks` is empty the original array is returned unchanged — a
 * true no-op so callers pay zero allocation cost today.
 */
export function injectContext(messages: ModelMessage[], blocks: ContextBlock[]): ModelMessage[] {
  if (blocks.length === 0) return messages;
  const contextText = blocks.map((b) => `[${b.source}]\n${b.text}`).join("\n\n");
  const systemBlock: ModelMessage = {
    role: "system",
    content: contextText,
  };
  return [systemBlock, ...messages];
}
