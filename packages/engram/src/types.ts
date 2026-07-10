/**
 * Core type definitions for the Engram memory substrate.
 *
 * Every memory in the system is a MemoryRecord — a content-addressed,
 * namespace-scoped, typed record with provenance and salience metadata.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Record Kind
// ---------------------------------------------------------------------------

export const RecordKindSchema = z.enum([
  "episodic",
  "semantic",
  "procedural",
  "entity",
  "edge",
]);

export type RecordKind = z.infer<typeof RecordKindSchema>;

// ---------------------------------------------------------------------------
// Namespace — hierarchical tenant + session scoping
// ---------------------------------------------------------------------------

export const NamespaceSchema = z.object({
  org: z.string().min(1),
  workspace: z.string().min(1),
  session: z.string().optional(),
  agent: z.string().optional(),
});

export type Namespace = z.infer<typeof NamespaceSchema>;

// ---------------------------------------------------------------------------
// Provenance — who/what created this record
// ---------------------------------------------------------------------------

export const ProvenanceSchema = z.object({
  /** Agent ID or user ID that authored this record. */
  author: z.string().min(1),
  /** Parent record IDs (content hashes) this was derived from. */
  derivedFrom: z.array(z.string()),
  /** Tool that produced this record, if any. */
  tool: z.string().optional(),
  /** LLM model used to generate this, if any. */
  model: z.string().optional(),
  /** Unix ms timestamp of creation. */
  timestamp: z.number().int().positive(),
});

export type Provenance = z.infer<typeof ProvenanceSchema>;

// ---------------------------------------------------------------------------
// Per-kind body types
// ---------------------------------------------------------------------------

export const EpisodicBodySchema = z.object({
  /** Event type (tool_call, observation, decision, reflection, etc.) */
  event: z.string().min(1),
  /** Structured event data. */
  payload: z.unknown(),
  /** Outcome if known. */
  outcome: z.enum(["success", "failure", "unknown"]).optional(),
});

export type EpisodicBody = z.infer<typeof EpisodicBodySchema>;

export const SemanticBodySchema = z.object({
  /** The distilled fact. */
  fact: z.string().min(1),
  /** Category (auth, db, api, infra, etc.) */
  domain: z.string().min(1),
  /** Record IDs this fact supersedes (replaces). */
  supersedes: z.array(z.string()).optional(),
});

export type SemanticBody = z.infer<typeof SemanticBodySchema>;

export const ProceduralBodySchema = z.object({
  /** The rule or instruction. */
  rule: z.string().min(1),
  /** Task/context patterns where this rule applies. */
  appliesTo: z.array(z.string()),
  /** Example applications of this rule. */
  examples: z.array(z.string()).optional(),
  /** Times this rule led to a successful outcome. */
  successCount: z.number().int().nonnegative(),
  /** Times this rule led to a failure. */
  failureCount: z.number().int().nonnegative(),
});

export type ProceduralBody = z.infer<typeof ProceduralBodySchema>;

export const EntityBodySchema = z.object({
  /** Entity type from ontology (file, function, service, person, etc.) */
  entityType: z.string().min(1),
  /** Human-readable name. */
  name: z.string().min(1),
  /** Arbitrary typed properties. */
  properties: z.record(z.unknown()),
});

export type EntityBody = z.infer<typeof EntityBodySchema>;

export const EdgeBodySchema = z.object({
  /** Source entity record ID. */
  sourceId: z.string().min(1),
  /** Target entity record ID. */
  targetId: z.string().min(1),
  /** Relationship type from EdgeTypes in ontology. */
  edgeType: z.string().min(1),
  /** Additional edge properties. */
  properties: z.record(z.unknown()).optional(),
});

export type EdgeBody = z.infer<typeof EdgeBodySchema>;

/**
 * Union of all body types. The discriminant is the parent record's `kind` field.
 */
export type RecordBody =
  | EpisodicBody
  | SemanticBody
  | ProceduralBody
  | EntityBody
  | EdgeBody;

// ---------------------------------------------------------------------------
// MemoryRecord — the core primitive
// ---------------------------------------------------------------------------

export const MemoryRecordSchema = z.object({
  /** Content-addressed ID: sha256(kind + namespace + body) — see hash.ts. */
  id: z.string().length(64),
  /** Discriminant for body type. */
  kind: RecordKindSchema,
  /** Tenant + session scoping. */
  namespace: NamespaceSchema,
  /** Typed body — shape depends on `kind`. */
  body: z.unknown(),
  /** Quantized embedding vector; optional at write time. */
  embedding: z.custom<Int8Array>().optional(),
  /** Importance at write time (0.0–1.0). */
  salience: z.number().min(0).max(1),
  /** Confidence for facts that may be wrong (0.0–1.0). */
  confidence: z.number().min(0).max(1),
  /** Who/what created this record. */
  provenance: ProvenanceSchema,
  /** Parent record IDs forming the causal DAG. */
  causality: z.array(z.string()),
  /** Unix ms expiry (optional). */
  ttl: z.number().int().positive().optional(),
  /** Unix ms creation timestamp. */
  createdAt: z.number().int().positive(),
});

export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

// ---------------------------------------------------------------------------
// Write options passed to the API layer
// ---------------------------------------------------------------------------

export interface WriteOpts {
  namespace: Namespace;
  salience?: number;
  causality?: string[];
  provenance: Provenance;
  /** Graph node reference this memory is about (creates :REMEMBERS edge). */
  nodeRef?: string;
  /** IDs of KnowledgeNode entities this memory relates to (creates :ABOUT edges). */
  entityRefs?: string[];
}
