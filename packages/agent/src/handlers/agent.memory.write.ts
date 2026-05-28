import type { CapabilityContext } from "../types.js";
import { writeMemory } from "../memory/neo4j.js";
import { embedText } from "../memory/embed.js";

export interface AgentMemoryWriteInput {
  nodeRef: string;
  weight: "low" | "high" | "critical";
  kind: "routine-change" | "constraint" | "bug-root-cause" | "convention-deviation" | "gotcha";
  lesson: string;
  source: "feature" | "fix" | "exception-watcher" | "bug-report";
}

export interface AgentMemoryWriteOutput {
  memoryId: string;
  nodeRef: string;
}

export async function agentMemoryWriteHandler(
  input: AgentMemoryWriteInput,
  ctx: CapabilityContext,
): Promise<AgentMemoryWriteOutput> {
  const embedding = await embedText(input.lesson);
  const { memoryId } = await writeMemory({
    tenantId: ctx.tenantId,
    workspaceId: ctx.workspaceId,
    nodeRef: input.nodeRef,
    embedding,
    weight: input.weight,
    kind: input.kind,
    lesson: input.lesson,
    source: input.source,
  });
  return { memoryId, nodeRef: input.nodeRef };
}
