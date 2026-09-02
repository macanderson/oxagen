/**
 * Migration type mappings from Neo4j AgentMemory → Engram MemoryRecord.
 *
 * Maps the existing MemoryRow shape (from packages/agent/src/memory/neo4j.ts)
 * to the new Engram record format.
 */
import type {
  RecordKind,
  EpisodicBody,
  SemanticBody,
  Namespace,
  Provenance,
} from "../types";

/**
 * The Neo4j MemoryRow shape — mirrors packages/agent/src/memory/neo4j.ts.
 * Kept here to avoid a hard import dependency on @oxagen/agent during migration.
 */
export interface LegacyMemoryRow {
  id: string;
  nodeRef: string;
  weight: "low" | "high" | "critical";
  kind: string;
  lesson: string;
  source: string;
  score: number;
  createdAt: string;
  orgId: string;
  workspaceId: string;
}

/**
 * Weight → salience mapping.
 * The old system used three discrete levels; we map to continuous [0,1].
 */
export const WEIGHT_TO_SALIENCE: Record<string, number> = {
  low: 0.3,
  high: 0.6,
  critical: 0.9,
};

/**
 * Neo4j kind → Engram RecordKind mapping.
 * The legacy system used free-form strings; we map to the closest enum value.
 */
const KIND_MAP: Record<string, RecordKind> = {
  observation: "episodic",
  decision: "episodic",
  tool_result: "episodic",
  reflection: "episodic",
  fact: "semantic",
  rule: "procedural",
  pattern: "procedural",
  entity: "entity",
  relationship: "edge",
};

/**
 * Map a legacy kind string to an Engram RecordKind.
 * Falls back to "episodic" for unknown kinds.
 */
export function mapKind(legacyKind: string): RecordKind {
  return KIND_MAP[legacyKind.toLowerCase()] ?? "episodic";
}

/**
 * Map a legacy memory row's lesson to an appropriate body.
 * If the mapped kind is "semantic", wraps in SemanticBody.
 * Otherwise wraps in EpisodicBody.
 */
export function mapBody(
  row: LegacyMemoryRow,
  kind: RecordKind,
): EpisodicBody | SemanticBody {
  if (kind === "semantic") {
    return {
      fact: row.lesson,
      domain: inferDomain(row),
    };
  }

  return {
    event: row.kind || "legacy_import",
    payload: {
      lesson: row.lesson,
      nodeRef: row.nodeRef,
      originalId: row.id,
    },
    outcome: "unknown",
  };
}

/**
 * Build a Namespace from legacy row fields.
 */
export function mapNamespace(row: LegacyMemoryRow): Namespace {
  return {
    org: row.orgId,
    workspace: row.workspaceId,
  };
}

/**
 * Build a Provenance for a migrated record.
 */
export function mapProvenance(row: LegacyMemoryRow): Provenance {
  return {
    author: "migration:neo4j-to-engram",
    derivedFrom: [row.id], // Reference original Neo4j ID
    tool: row.source || undefined,
    timestamp: parseCreatedAt(row.createdAt),
  };
}

/**
 * Infer a domain category from the legacy row for semantic records.
 */
function inferDomain(row: LegacyMemoryRow): string {
  // Simple heuristic based on source field
  if (row.source.includes("code") || row.source.includes("file")) return "code";
  if (row.source.includes("api") || row.source.includes("http")) return "api";
  if (row.source.includes("db") || row.source.includes("database"))
    return "database";
  if (row.source.includes("auth")) return "auth";
  return "general";
}

/**
 * Parse a legacy createdAt string to Unix ms.
 * Handles ISO strings and Neo4j datetime formats.
 */
export function parseCreatedAt(createdAt: string): number {
  const parsed = Date.parse(createdAt);
  if (Number.isNaN(parsed)) return Date.now();
  return parsed;
}
