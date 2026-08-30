import type { CapabilityContext } from "../types";
import {
  getMemoryById,
  recordCitation,
  recordExecution,
} from "../memory/neo4j";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import { deriveCompliance } from "@oxagen/oxagen/contracts/agent.memory.model";
import type {
  AgentMemoryCiteInput,
  AgentMemoryCiteOutput,
} from "@oxagen/oxagen/contracts/agent.memory.cite";

export type { AgentMemoryCiteInput, AgentMemoryCiteOutput };

// The workspace `complianceThreshold` policy knob (agent.memory.policy.*) is
// not wired into this package; 70 mirrors memoryPolicySchema's default
// (docs/specs/two-axis-memory/DESIGN.md §Enums) until that read path exists.
const DEFAULT_COMPLIANCE_THRESHOLD = 70;

/**
 * agent.memory.cite — record that an execution retrieved and used memories
 * (docs/specs/two-axis-memory §6). MERGEs the :Execution, snapshots each
 * memory's enforcement/confidence at cite time, derives rule compliance
 * server-side, and writes a :Citation per memory — never all-or-nothing, a
 * missing memory only fails its own result row.
 */
export async function agentMemoryCiteHandler(
  input: AgentMemoryCiteInput,
  _ctx: CapabilityContext,
): Promise<AgentMemoryCiteOutput> {
  if (!isKnowledgeGraphEnabled()) {
    return {
      executionId: "",
      results: input.citations.map((c) => ({
        memoryId: c.memoryId,
        ok: false,
        citationId: null,
        compliance: "NA" as const,
        error: "Knowledge graph is not configured for this workspace.",
      })),
      recorded: 0,
    };
  }

  const { executionId } = await recordExecution({
    executionRef: input.executionRef,
    agentId: input.agentId,
    runId: input.runId,
    taskSummary: input.taskSummary,
  });

  const results: AgentMemoryCiteOutput["results"] = [];
  for (const citation of input.citations) {
    const memory = await getMemoryById(citation.memoryId);
    if (!memory) {
      results.push({
        memoryId: citation.memoryId,
        ok: false,
        citationId: null,
        compliance: "NA",
        error: `Memory ${citation.memoryId} not found in this workspace.`,
      });
      continue;
    }

    // Only a RULE carries an enforcement score to weigh deviation against;
    // OBSERVATION/FACT citations are always NA per deriveCompliance.
    const enforcement =
      memory.memoryClass === "RULE" ? memory.enforcementScore : null;
    const compliance = deriveCompliance({
      enforcement,
      deviated: citation.deviated,
      threshold: DEFAULT_COMPLIANCE_THRESHOLD,
    });

    try {
      const created = await recordCitation({
        executionId,
        memoryId: citation.memoryId,
        influence: citation.influence,
        compliance,
        enforcementAtCite: enforcement,
        confidenceAtCite: memory.confidenceScore,
        expectedValue: citation.expectedValue,
        observedValue: citation.observedValue,
        agentRationale: citation.agentRationale,
      });
      results.push({
        memoryId: citation.memoryId,
        ok: created != null,
        citationId: created?.citationId ?? null,
        compliance,
        error: created ? null : "recordCitation returned no citation id",
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to record citation";
      results.push({
        memoryId: citation.memoryId,
        ok: false,
        citationId: null,
        compliance,
        error: message,
      });
    }
  }

  const recorded = results.filter((r) => r.ok).length;
  return { executionId, results, recorded };
}
