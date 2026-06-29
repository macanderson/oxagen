import type { CapabilityContext } from "../types";
import { updateMemory } from "../memory/neo4j";
import { embedText } from "../memory/embed";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import type {
  AgentMemoryUpdateInput,
  AgentMemoryUpdateOutput,
} from "@oxagen/oxagen/contracts/agent.memory.update";

export type { AgentMemoryUpdateInput, AgentMemoryUpdateOutput };

export async function agentMemoryUpdateHandler(
  input: AgentMemoryUpdateInput,
  ctx: CapabilityContext,
): Promise<AgentMemoryUpdateOutput> {
  // The contract keeps `input` a plain object (so MCP can spread its shape), so
  // the "change at least one field" rule is enforced here rather than via a
  // ZodEffects refinement.
  if (
    input.lesson === undefined &&
    input.weight === undefined &&
    input.kind === undefined &&
    input.source === undefined &&
    input.confidence === undefined
  ) {
    throw new Error(
      "agent.memory.update requires at least one field to change (lesson, weight, kind, source, or confidence).",
    );
  }

  if (!isKnowledgeGraphEnabled()) {
    throw new Error(
      "Knowledge graph is not configured; agent.memory.update has no store to write to.",
    );
  }

  // Re-embed only when the lesson text changes so semantic recall keeps matching
  // the current wording. Metering context flows through so the embed lands in
  // token_usage like every other AI call.
  let embedding: number[] | undefined;
  if (input.lesson !== undefined) {
    embedding = await embedText(input.lesson, {
      telemetry: {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: ctx.surface,
        executionStepId: ctx.messageId ?? ctx.requestId,
      },
    });
  }

  const updated = await updateMemory({
    memoryId: input.memoryId,
    lesson: input.lesson,
    weight: input.weight,
    kind: input.kind,
    source: input.source,
    confidence: input.confidence,
    embedding,
  });

  if (!updated) {
    throw new Error(`Memory ${input.memoryId} not found in this workspace.`);
  }

  return updated;
}
