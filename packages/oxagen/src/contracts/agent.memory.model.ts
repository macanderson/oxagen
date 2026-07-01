import { z } from "zod";

/**
 * agent.memory.model — the single source of truth for the two-axis memory model
 * shared across every agent.memory.* contract (see docs/specs/two-axis-memory).
 *
 * Memory has TWO independent axes, not one:
 *   - memory_class = epistemic status (the confidence ladder): OBSERVATION → RULE → FACT
 *   - memory_kind  = content domain (extensible open string)
 *
 * and TWO independent weights:
 *   - confidenceScore (0-100): how sure we are it is TRUE. Auto-decays, recovers on evidence.
 *   - enforcementScore (1-100): how strongly it SHOULD be followed. Policy; no auto-decay.
 *
 * These enums/consts are re-exported by the individual contracts so the entire
 * API/MCP/CLI/UI surface derives from one declaration and can never drift.
 */

/** Epistemic status — the confidence ladder. */
export const memoryClassEnum = z.enum(["OBSERVATION", "RULE", "FACT"]);
export type MemoryClass = z.infer<typeof memoryClassEnum>;

/**
 * Content domain. Extensible per the schema, so this is an open string (min 1)
 * rather than a closed enum. RECOMMENDED_MEMORY_KINDS documents the canonical
 * set — the schema's content domains plus the retained engineering kinds so
 * existing memories and the classifier stay valid.
 */
export const RECOMMENDED_MEMORY_KINDS = [
  "FEEDBACK",
  "PERFORMANCE",
  "STYLE",
  "PREFERENCE",
  "VOICE",
  "PROSE",
  "routine-change",
  "constraint",
  "bug-root-cause",
  "convention-deviation",
  "gotcha",
] as const;

export const memoryKindSchema = z
  .string()
  .min(1)
  .max(64)
  .describe(
    `Content domain the memory is about. Extensible; canonical values: ${RECOMMENDED_MEMORY_KINDS.join(", ")}`,
  );

/** Lifecycle status; only ACTIVE memories are read by recall/list. */
export const memoryStatusEnum = z.enum([
  "ACTIVE",
  "SUPERSEDED",
  "RETRACTED",
  "ARCHIVED",
]);
export type MemoryStatus = z.infer<typeof memoryStatusEnum>;

/** Who created/confirmed a memory, promotion, or citation. */
export const actorKindEnum = z.enum(["AGENT", "USER", "SYSTEM"]);
export type ActorKind = z.infer<typeof actorKindEnum>;

/** Did a cited memory actually shape the output? */
export const influenceEnum = z.enum([
  "DECISIVE",
  "CONTRIBUTING",
  "CONSIDERED",
  "IGNORED",
]);
export type Influence = z.infer<typeof influenceEnum>;

/** Rule-specific compliance outcome for a citation. */
export const complianceEnum = z.enum([
  "COMPLIED",
  "DISCRETION",
  "VIOLATION",
  "NA",
]);
export type Compliance = z.infer<typeof complianceEnum>;

/** What kind of signal corroborates (or refutes) a memory. */
export const evidenceSourceKindEnum = z.enum([
  "CITATION",
  "HUMAN_CONFIRM",
  "CODE_SCAN",
  "AGENT_JUDGE",
  "REPEAT_OBSERVATION",
]);
export type EvidenceSourceKind = z.infer<typeof evidenceSourceKindEnum>;

/**
 * The canonical memory record shape — also the exact projection returned by the
 * repository (`packages/agent/src/memory/neo4j.ts`). Stored under the
 * `:AgentMemory` label; the schema's logical `:Memory` maps onto it. `lesson` is
 * the memory body (≡ schema `body`).
 */
export const agentMemoryRecordSchema = z.object({
  id: z.string(),
  publicId: z.string(),
  nodeRef: z.string(),
  memoryClass: memoryClassEnum,
  memoryKind: memoryKindSchema,
  lesson: z.string().describe("The memory body, human readable"),
  source: z.string(),
  /** 0-100. Evidence measure; auto-decays. */
  confidenceScore: z.number().min(0).max(100),
  /** 1-100 for RULE, 100 for FACT, null for OBSERVATION. */
  enforcementScore: z.number().int().min(1).max(100).nullable(),
  status: memoryStatusEnum,
  subjectHint: z.string(),
  halfLifeDays: z.number(),
  decayFloor: z.number(),
  lastEvidenceAt: z.string().nullable(),
  citationCount: z.number().int().nonnegative(),
  influenceCount: z.number().int().nonnegative(),
  violationCount: z.number().int().nonnegative(),
  createdByKind: actorKindEnum,
  createdById: z.string().nullable(),
  confirmedByKind: actorKindEnum.nullable(),
  confirmedById: z.string().nullable(),
  createdAt: z.string(),
  lastReinforcedAt: z.string().nullable(),
});

export type AgentMemoryRecord = z.output<typeof agentMemoryRecordSchema>;

/**
 * Enforce the class↔enforcement↔confirmation invariants. Returns a normalized
 * `{ memoryClass, enforcementScore, confirmedByKind, confirmedById }` or throws
 * a descriptive Error. Call from any handler that sets a memory's class.
 */
export function assertMemoryClassInvariants(input: {
  memoryClass: MemoryClass;
  enforcementScore?: number | null;
  confirmedByKind?: ActorKind | null;
  confirmedById?: string | null;
}): {
  memoryClass: MemoryClass;
  enforcementScore: number | null;
  confirmedByKind: ActorKind | null;
  confirmedById: string | null;
} {
  const { memoryClass } = input;
  if (memoryClass === "OBSERVATION") {
    return {
      memoryClass,
      enforcementScore: null,
      confirmedByKind: input.confirmedByKind ?? null,
      confirmedById: input.confirmedById ?? null,
    };
  }
  if (memoryClass === "FACT") {
    if (input.confirmedByKind !== "USER") {
      throw new Error(
        "A FACT requires confirmed_by_kind = USER (a human must confirm it)",
      );
    }
    return {
      memoryClass,
      enforcementScore: 100,
      confirmedByKind: "USER",
      confirmedById: input.confirmedById ?? null,
    };
  }
  // RULE
  const e = input.enforcementScore;
  if (e == null || e < 1 || e > 100) {
    throw new Error("A RULE requires enforcement_score between 1 and 100");
  }
  return {
    memoryClass,
    enforcementScore: e,
    confirmedByKind: input.confirmedByKind ?? null,
    confirmedById: input.confirmedById ?? null,
  };
}

/**
 * Derive the compliance outcome for a citation (schema §6). `enforcement` is the
 * enforcement_score at cite time; `threshold` is the workspace policy knob
 * (default 70). Non-rules (null enforcement) are always NA.
 */
export function deriveCompliance(args: {
  enforcement: number | null | undefined;
  deviated: boolean;
  threshold?: number;
}): Compliance {
  const threshold = args.threshold ?? 70;
  if (args.enforcement == null) return "NA";
  if (!args.deviated) return "COMPLIED";
  return args.enforcement >= threshold ? "VIOLATION" : "DISCRETION";
}
