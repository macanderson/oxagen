import type { CapabilityContext } from "../types";
import { recordExecution, recordMentionCitation } from "../memory/neo4j";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import type {
  ReferenceCiteInput,
  ReferenceCiteOutput,
} from "@oxagen/oxagen/contracts/reference.cite";

export type { ReferenceCiteInput, ReferenceCiteOutput };

/**
 * reference.cite — record @-mention citations of knowledge-graph nodes.
 *
 * A user attaching a node to a chat turn is a deliberate citation: MERGE the
 * turn's :Execution, then per mentioned node write a :Citation (source
 * 'mention') and bump `citation_count` — identical bookkeeping to the agent's
 * automatic memory citations, so manual and automatic references count the
 * same. Never all-or-nothing: a missing node only fails its own result row.
 */
export async function referenceCiteHandler(
  input: ReferenceCiteInput,
  _ctx: CapabilityContext,
): Promise<ReferenceCiteOutput> {
  if (!isKnowledgeGraphEnabled()) {
    return {
      executionId: "",
      results: input.references.map((r) => ({
        nodeId: r.nodeId,
        ok: false,
        citationId: null,
        error: "Knowledge graph is not configured for this workspace.",
      })),
      recorded: 0,
    };
  }

  const { executionId } = await recordExecution({
    executionRef: input.executionRef,
    agentId: input.agentId,
    taskSummary: input.taskSummary,
  });

  const results: ReferenceCiteOutput["results"] = [];
  for (const reference of input.references) {
    try {
      const citation = await recordMentionCitation({
        executionId,
        nodePublicId: reference.nodeId,
      });
      results.push({
        nodeId: reference.nodeId,
        ok: citation !== null,
        citationId: citation?.citationId ?? null,
        error: citation
          ? null
          : `Node ${reference.nodeId} not found in this workspace.`,
      });
    } catch (err) {
      results.push({
        nodeId: reference.nodeId,
        ok: false,
        citationId: null,
        error: err instanceof Error ? err.message : "Citation write failed.",
      });
    }
  }

  return {
    executionId,
    results,
    recorded: results.filter((r) => r.ok).length,
  };
}
