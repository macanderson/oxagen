import type { CapabilityContext } from "../types";
import { writeMemory } from "../memory/neo4j";
import type { ActorKind } from "../memory/neo4j";
import { embedText } from "../memory/embed";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import { mapWithConcurrency } from "../memory/import";
import { assertMemoryClassInvariants } from "@oxagen/oxagen/contracts/agent.memory.model";
import type {
  AgentMemoryImportCommitInput,
  AgentMemoryImportCommitOutput,
} from "@oxagen/oxagen/contracts/agent.memory_import.commit";

export type { AgentMemoryImportCommitInput, AgentMemoryImportCommitOutput };

/** Free-form notes with no code anchor group under this synthetic ref. */
const USER_MEMORY_NODE_REF = "user-memory";

// Each write embeds the lesson (a metered AI call). Cap concurrency so a
// 200-draft commit doesn't open 200 simultaneous embedding requests.
const WRITE_CONCURRENCY = 5;

/** `source` "user" is a human-provenance write; everything else is agent-provenance. */
function createdByKindFromSource(source: string): ActorKind {
  return source === "user" ? "USER" : "AGENT";
}

/**
 * agent.memory.import.commit — persist confirmed draft memories into the
 * workspace AgentMemory graph. Per-item error capture: each draft is embedded
 * and written independently, so one failure never aborts the batch. Results are
 * positional — results[i] corresponds to drafts[i].
 *
 * Mirrors plugin.org.install_bulk's "not all-or-nothing" contract. Defaults for
 * nodeRef/source/memoryClass are applied defensively because invoke() does not
 * guarantee the input was parsed through the contract schema (same reason
 * agent.memory.remember applies its own `?? "user"`).
 */
export async function agentMemoryImportCommitHandler(
  input: AgentMemoryImportCommitInput,
  ctx: CapabilityContext,
): Promise<AgentMemoryImportCommitOutput> {
  // No graph configured → nothing can be persisted. Report every draft as failed
  // so the caller surfaces the misconfiguration rather than silently succeeding.
  if (!isKnowledgeGraphEnabled()) {
    const results = input.drafts.map((draft) => ({
      lesson: draft.lesson,
      ok: false,
      memoryId: null,
      error: "Knowledge graph is not configured for this workspace.",
    }));
    return { results, imported: 0, failed: results.length };
  }

  const results = await mapWithConcurrency(
    input.drafts,
    WRITE_CONCURRENCY,
    async (draft) => {
      try {
        const source = draft.source ?? "user";
        const memoryClass = draft.memoryClass ?? "OBSERVATION";
        // Re-validates the class↔enforcement invariants at write time — a draft
        // hand-edited in the review grid could have drifted (e.g. RULE with no
        // enforcementScore); a per-item failure here is captured below rather
        // than aborting the batch.
        const invariants = assertMemoryClassInvariants({
          memoryClass,
          enforcementScore: draft.enforcementScore ?? null,
        });
        const embedding = await embedText(draft.lesson, {
          telemetry: {
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
            surface: ctx.surface,
            executionStepId: ctx.messageId ?? ctx.requestId,
          },
        });
        const { memoryId } = await writeMemory({
          nodeRef: draft.nodeRef ?? USER_MEMORY_NODE_REF,
          embedding,
          memoryClass: invariants.memoryClass,
          memoryKind: draft.memoryKind,
          enforcementScore: invariants.enforcementScore,
          lesson: draft.lesson,
          source,
          createdByKind: createdByKindFromSource(source),
          createdById: source,
          confirmedByKind: invariants.confirmedByKind,
          confirmedById: invariants.confirmedById,
        });
        return { lesson: draft.lesson, ok: true, memoryId, error: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Write failed";
        return {
          lesson: draft.lesson,
          ok: false,
          memoryId: null,
          error: message,
        };
      }
    },
  );

  const imported = results.filter((r) => r.ok).length;
  return { results, imported, failed: results.length - imported };
}
