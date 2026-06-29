import { z } from "zod";
import { generateObjectFor } from "@oxagen/ai";
import type { CapabilityContext } from "../types";
import { writeMemory, getMemoryById } from "../memory/neo4j";
import { embedText } from "../memory/embed";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import { MEMORY_KIND_GUIDE, MEMORY_WEIGHT_GUIDE } from "../memory/taxonomy";
import type {
  AgentMemoryRememberInput,
  AgentMemoryRememberOutput,
} from "@oxagen/oxagen/contracts/agent.memory.remember";

export type { AgentMemoryRememberInput, AgentMemoryRememberOutput };

type MemoryKind =
  | "routine-change"
  | "constraint"
  | "bug-root-cause"
  | "convention-deviation"
  | "gotcha";
type MemoryWeight = "low" | "high" | "critical";

/** Free-form notes with no code anchor group under this synthetic ref. */
const USER_MEMORY_NODE_REF = "user-memory";

// Default classification when the model is unavailable (no gateway key, AI
// error). A deliberately-captured human note is worth surfacing, so it defaults
// to `high` (default recall reads high+critical); `constraint` is the safest
// catch-all kind for "something the agent should respect going forward".
const DEFAULT_KIND: MemoryKind = "constraint";
const DEFAULT_WEIGHT: MemoryWeight = "high";

const classificationSchema = z.object({
  kind: z.enum([
    "routine-change",
    "constraint",
    "bug-root-cause",
    "convention-deviation",
    "gotcha",
  ]),
  weight: z.enum(["low", "high", "critical"]),
});

// Taxonomy bullets are shared with the bulk-import extractor via memory/taxonomy
// so a definition change updates both classifiers at once.
const CLASSIFIER_SYSTEM = [
  "You classify a single user-captured engineering memory into a kind and a salience weight.",
  "",
  MEMORY_KIND_GUIDE,
  "",
  MEMORY_WEIGHT_GUIDE,
  "",
  "Default to constraint/high when unsure. Respond with the structured object only.",
].join("\n");

/**
 * Infer the kind + weight for a free-text memory. Best-effort: any failure
 * (no gateway key, model error) falls back to the safe defaults so /remember
 * never fails just because classification was unavailable.
 */
async function classifyMemory(
  text: string,
  ctx: CapabilityContext,
): Promise<{ kind: MemoryKind; weight: MemoryWeight; viaModel: boolean }> {
  try {
    const { object } = await generateObjectFor({
      schema: classificationSchema,
      system: CLASSIFIER_SYSTEM,
      prompt: text,
      telemetry: {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: ctx.surface,
        messageId: ctx.messageId,
      },
    });
    return { kind: object.kind, weight: object.weight, viaModel: true };
  } catch {
    return { kind: DEFAULT_KIND, weight: DEFAULT_WEIGHT, viaModel: false };
  }
}

export async function agentMemoryRememberHandler(
  input: AgentMemoryRememberInput,
  ctx: CapabilityContext,
): Promise<AgentMemoryRememberOutput> {
  const nodeRef = input.nodeRef ?? USER_MEMORY_NODE_REF;
  const source = input.source ?? "user";

  // Infer only what the caller did not pin. `classified` is true only when the
  // model actually decided at least one of the two values.
  let kind = input.kind as MemoryKind | undefined;
  let weight = input.weight as MemoryWeight | undefined;
  let classified = false;
  if (kind === undefined || weight === undefined) {
    const inferred = await classifyMemory(input.text, ctx);
    if (kind === undefined) kind = inferred.kind;
    if (weight === undefined) weight = inferred.weight;
    classified = inferred.viaModel;
  }
  const finalKind: MemoryKind = kind ?? DEFAULT_KIND;
  const finalWeight: MemoryWeight = weight ?? DEFAULT_WEIGHT;

  // No graph configured → return a schema-valid sentinel (empty id) so callers
  // can detect the no-op, mirroring agent.memory.write.
  if (!isKnowledgeGraphEnabled()) {
    return {
      memory: {
        id: "",
        publicId: "",
        nodeRef,
        weight: finalWeight,
        kind: finalKind,
        lesson: input.text,
        source,
        confidence: 1,
        createdAt: new Date().toISOString(),
        lastReinforcedAt: null,
      },
      inferred: { kind: finalKind, weight: finalWeight, classified },
    };
  }

  const embedding = await embedText(input.text, {
    telemetry: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
      executionStepId: ctx.messageId ?? ctx.requestId,
    },
  });

  const { memoryId } = await writeMemory({
    nodeRef,
    embedding,
    weight: finalWeight,
    kind: finalKind,
    lesson: input.text,
    source,
    relatedNodeIds: input.relatedNodeIds,
  });

  // Return the persisted projection so the caller gets the real publicId +
  // timestamps. Fall back to a constructed record if the read races (it won't
  // under normal operation, but the contract output must always be populated).
  const record = await getMemoryById(memoryId);
  return {
    memory: record ?? {
      id: memoryId,
      publicId: memoryId,
      nodeRef,
      weight: finalWeight,
      kind: finalKind,
      lesson: input.text,
      source,
      confidence: 1,
      createdAt: new Date().toISOString(),
      lastReinforcedAt: new Date().toISOString(),
    },
    inferred: { kind: finalKind, weight: finalWeight, classified },
  };
}
