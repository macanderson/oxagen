import { z } from "zod";
import { generateObjectFor } from "@oxagen/ai";
import type { CapabilityContext } from "../types";
import { writeMemory, getMemoryById } from "../memory/neo4j";
import type { ActorKind, MemoryClass } from "../memory/neo4j";
import { embedText } from "../memory/embed";
import { isKnowledgeGraphEnabled } from "../runtime/knowledge-graph";
import { MEMORY_CLASS_GUIDE, MEMORY_KIND_GUIDE } from "../memory/taxonomy";
import {
  assertMemoryClassInvariants,
  memoryKindSchema,
} from "@oxagen/oxagen/contracts/agent.memory.model";
import type {
  AgentMemoryRememberInput,
  AgentMemoryRememberOutput,
} from "@oxagen/oxagen/contracts/agent.memory.remember";

export type { AgentMemoryRememberInput, AgentMemoryRememberOutput };

/** Free-form notes with no code anchor group under this synthetic ref. */
const USER_MEMORY_NODE_REF = "user-memory";

// Safe defaults when the model is unavailable, or the caller pins neither axis
// and classification could not run. OBSERVATION is the taxonomy's "safe
// default" epistemic class; 'constraint' is the safest catch-all kind.
const DEFAULT_MEMORY_CLASS = "OBSERVATION" as const;
const DEFAULT_MEMORY_KIND = "constraint";

// Mid-strength fallback enforcement when the classifier (or a caller) selects
// RULE without pinning an explicit score. A human can tighten/loosen it later
// via agent.memory.update or agent.memory.promote.
const DEFAULT_RULE_ENFORCEMENT = 50;

// Mirrors the per-class half-life defaults in memory/neo4j.ts (not exported
// there). Only used to populate the schema-valid no-graph sentinel / read-race
// fallback record below — never persisted directly (writeMemory computes its
// own half-life server-side).
const HALF_LIFE_BY_CLASS: Record<MemoryClass, number> = {
  OBSERVATION: 30,
  RULE: 90,
  FACT: 36500,
};

const DEFAULT_DECAY_FLOOR = 5;

// The classifier only ever chooses between OBSERVATION and RULE — FACT is
// reachable solely through agent.memory.promote (requires human confirmation).
const classificationSchema = z.object({
  memoryClass: z.enum(["OBSERVATION", "RULE"]),
  memoryKind: memoryKindSchema,
});

// Taxonomy bullets are shared with the bulk-import extractor via memory/taxonomy
// so a definition change updates both classifiers at once.
const CLASSIFIER_SYSTEM = [
  "You classify a single user-captured agent memory into its two-axis class and kind.",
  "",
  MEMORY_CLASS_GUIDE,
  "",
  MEMORY_KIND_GUIDE,
  "",
  "Default to OBSERVATION/constraint when unsure. Respond with the structured object only.",
].join("\n");

/**
 * Infer the class + kind for a free-text memory. Best-effort: any failure
 * (no gateway key, model error) falls back to the safe defaults so /remember
 * never fails just because classification was unavailable.
 */
async function classifyMemory(
  text: string,
  ctx: CapabilityContext,
): Promise<{
  memoryClass: "OBSERVATION" | "RULE";
  memoryKind: string;
  viaModel: boolean;
}> {
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
    return {
      memoryClass: object.memoryClass,
      memoryKind: object.memoryKind,
      viaModel: true,
    };
  } catch {
    return {
      memoryClass: DEFAULT_MEMORY_CLASS,
      memoryKind: DEFAULT_MEMORY_KIND,
      viaModel: false,
    };
  }
}

/** `source` "user" is a human-provenance write; everything else is agent-provenance. */
function createdByKindFromSource(source: string): ActorKind {
  return source === "user" ? "USER" : "AGENT";
}

export async function agentMemoryRememberHandler(
  input: AgentMemoryRememberInput,
  ctx: CapabilityContext,
): Promise<AgentMemoryRememberOutput> {
  const nodeRef = input.nodeRef ?? USER_MEMORY_NODE_REF;
  const source = input.source ?? "user";

  // Infer only what the caller did not pin. `classified` is true only when the
  // model actually decided at least one of the two axes.
  let memoryClass = input.memoryClass;
  let memoryKind = input.memoryKind;
  let classified = false;
  if (memoryClass === undefined || memoryKind === undefined) {
    const inferred = await classifyMemory(input.text, ctx);
    if (memoryClass === undefined) memoryClass = inferred.memoryClass;
    if (memoryKind === undefined) memoryKind = inferred.memoryKind;
    classified = inferred.viaModel;
  }
  const finalMemoryClass = memoryClass ?? DEFAULT_MEMORY_CLASS;
  const finalMemoryKind = memoryKind ?? DEFAULT_MEMORY_KIND;

  let enforcementScore = input.enforcementScore ?? null;
  if (finalMemoryClass === "RULE" && enforcementScore == null) {
    enforcementScore = DEFAULT_RULE_ENFORCEMENT;
  }

  // A memory captured through /remember with source "user" is, definitionally,
  // human-confirmed — the one path where a pinned FACT can satisfy
  // assertMemoryClassInvariants without a separate agent.memory.promote call.
  const isUserSourced = source === "user";
  const invariants = assertMemoryClassInvariants({
    memoryClass: finalMemoryClass,
    enforcementScore,
    confirmedByKind: isUserSourced ? "USER" : null,
    confirmedById: isUserSourced ? ctx.userId : null,
  });

  const createdByKind = createdByKindFromSource(source);
  const nowIso = new Date().toISOString();

  function buildFallbackRecord(memoryId: string, publicId: string) {
    return {
      id: memoryId,
      publicId,
      nodeRef,
      memoryClass: invariants.memoryClass,
      memoryKind: finalMemoryKind,
      lesson: input.text,
      source,
      confidenceScore: 100,
      enforcementScore: invariants.enforcementScore,
      status: "ACTIVE" as const,
      subjectHint: nodeRef,
      halfLifeDays: HALF_LIFE_BY_CLASS[invariants.memoryClass],
      decayFloor: DEFAULT_DECAY_FLOOR,
      lastEvidenceAt: nowIso,
      citationCount: 0,
      influenceCount: 0,
      violationCount: 0,
      createdByKind,
      createdById: source,
      confirmedByKind: invariants.confirmedByKind,
      confirmedById: invariants.confirmedById,
      createdAt: nowIso,
      lastReinforcedAt: null,
    };
  }

  // No graph configured → return a schema-valid sentinel (empty id) so callers
  // can detect the no-op, mirroring agent.memory.write.
  if (!isKnowledgeGraphEnabled()) {
    return {
      memory: buildFallbackRecord("", ""),
      inferred: {
        memoryClass: finalMemoryClass,
        memoryKind: finalMemoryKind,
        classified,
      },
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
    memoryClass: invariants.memoryClass,
    memoryKind: finalMemoryKind,
    enforcementScore: invariants.enforcementScore,
    lesson: input.text,
    source,
    createdByKind,
    createdById: source,
    confirmedByKind: invariants.confirmedByKind,
    confirmedById: invariants.confirmedById,
    relatedNodeIds: input.relatedNodeIds,
  });

  // Return the persisted projection so the caller gets the real publicId +
  // timestamps. Fall back to a constructed record if the read races (it won't
  // under normal operation, but the contract output must always be populated).
  const record = await getMemoryById(memoryId);
  return {
    memory: record ?? buildFallbackRecord(memoryId, memoryId),
    inferred: {
      memoryClass: finalMemoryClass,
      memoryKind: finalMemoryKind,
      classified,
    },
  };
}
