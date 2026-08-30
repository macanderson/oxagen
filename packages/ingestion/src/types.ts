/**
 * Universal ingestion pipeline types.
 *
 * Every data source connector — GitHub, Google Workspace, Zoom, custom SQL,
 * Salesforce, etc. — produces EntityMutations that flow through these stages:
 *
 *   1. Receive     RawIngestEvent arrives (webhook or poller)
 *   2. Normalize   connector.normalizeRecord() → NormalizedRecord
 *   3. Map         look up ingestion.entity_type_mappings → EntityMutation
 *                  skip record if no mapping configured for this sourceRecordType
 *   4. Dedup       naturalKey lookup → match existing node OR create principal
 *                  embedding similarity → ALIAS_OF edge with confidence score
 *   5. Embed       embedText() → store vector on Neo4j node
 *
 * Stages fire each other via Inngest. Each stage is independently retryable.
 *
 * Storage model:
 *   Neo4j     — all ingested entity nodes (100%, no dual-write)
 *   Postgres  — connection config, encrypted credentials, entity_type_mappings
 *   ClickHouse — raw event audit log, ingestion telemetry
 *
 * Entity types are customer-configured workspace-scoped strings (e.g. "task",
 * "document") looked up from ingestion.entity_type_mappings at Stage 3.
 * Connectors never know or decide entity types — they only produce source
 * record types (e.g. "pull_request", "issue") that customers map to their
 * ontology during the connection setup wizard.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Stage 1 — Raw event (one per entity mutation from any source)
// ---------------------------------------------------------------------------

export interface RawIngestEvent {
  connectionId: string;
  workspaceId: string;
  orgId: string;
  /** Connector slug: "github" | "google-drive" | "zoom" | "custom-sql" | etc. */
  connectorType: string;
  /** Raw record type from the source: "pull_request" | "issue" | "file" | etc. */
  sourceRecordType: string;
  /**
   * Stable idempotency key.
   * Convention: `{connectorType}:{connectionId}:{sourceRecordType}:{externalId}`
   */
  idempotencyKey: string;
  payload: unknown;
  receivedAt: string; // ISO-8601
}

// ---------------------------------------------------------------------------
// Stage 2 — Normalized entity mutation (output of ConnectorPlugin.normalize)
// ---------------------------------------------------------------------------

export const EntityOperationSchema = z.enum(["insert", "update", "delete"]);
export type EntityOperation = z.infer<typeof EntityOperationSchema>;

export interface SourceRef {
  connectorType: string;
  connectionId: string;
  /** The entity's ID in the source system — used for dedup and deep links. */
  externalId: string;
  externalUrl?: string;
}

export interface EntityMutation {
  workspaceId: string;
  orgId: string;
  connectionId: string;
  /**
   * Customer-configured entity type string, looked up from
   * ingestion.entity_type_mappings. Workspace-scoped. Never a hardcoded enum.
   * Examples: "task", "document", "code_change", "contact"
   */
  entityType: string;
  /**
   * Raw record type from the connector, preserved for provenance.
   * Examples: "pull_request", "issue", "file", "event"
   */
  sourceRecordType: string;
  /**
   * Stable, globally unique deduplication key.
   * Convention: `{connectorType}:{connectionId}:{externalId}`
   * Example:    `github:conn_abc:42`
   */
  naturalKey: string;
  operation: EntityOperation;
  displayName?: string;
  properties: Record<string, unknown>;
  sourceRef: SourceRef;
}

// ---------------------------------------------------------------------------
// Stage 3 — Deduplication + alias resolution
// ---------------------------------------------------------------------------

export const DeduplicationActionSchema = z.enum([
  /** naturalKey matched an existing principal — properties updated in place. */
  "updated_principal",
  /** No match found — new principal node created. */
  "created_principal",
  /**
   * Embedding + property similarity matched an existing node above the alias
   * threshold. New node created as an alias of the existing principal.
   * An ALIAS_OF edge is written with confidence score and matchReason.
   */
  "created_alias",
  /**
   * A previously tentative alias has been confirmed (confidence upgraded to
   * CONFIRMED level, or a human approved it).
   */
  "confirmed_alias",
]);
export type DeduplicationAction = z.infer<typeof DeduplicationActionSchema>;

export type AliasMatchReason =
  | "natural_key_exact" // same externalId from same connector type
  | "email_match" // identical email property
  | "url_match" // identical canonical URL
  | "name_embedding" // high-cosine-similarity on display name
  | "property_embedding" // high-cosine-similarity on full property vector
  | "cross_source_id" // explicit cross-system ID hint (e.g. GitHub login in Linear profile)
  | "human_confirmed"; // a workspace user approved the alias

export const DeduplicationActionRejectedSchema = z.literal(
  "rejected_nonconformant",
);

export interface DeduplicationResult {
  /** Neo4j publicId of the canonical (principal) node. Null on a strict reject. */
  principalNodeId: string | null;
  /** Neo4j publicId of a new alias node, if action === "created_alias". */
  aliasNodeId?: string;
  action: DeduplicationAction | "rejected_nonconformant";
  /**
   * Set when enforcement_mode='strict' rejected the write as non-conformant.
   * The node was not written; the pipeline surfaces a filtered result.
   */
  rejected?: boolean;
  /** Conformance score (0.0–1.0) when a pinned schema was evaluated. */
  conformanceScore?: number;
  /**
   * Confidence that this entity IS the same real-world entity as the principal.
   * Range: 0.0–1.0.
   * >= ALIAS_THRESHOLD (0.70)    → create alias
   * >= CONFIRM_THRESHOLD (0.92)  → auto-confirm alias (skip human review)
   */
  confidence: number;
  matchReason?: AliasMatchReason;
}

export const ALIAS_THRESHOLD = 0.7;
export const CONFIRM_THRESHOLD = 0.92;

// ---------------------------------------------------------------------------
// Stage 4 — Embedding
// ---------------------------------------------------------------------------

export interface EmbedRequest {
  /** Neo4j publicId of the node to embed. */
  nodeId: string;
  entityType: string;
  /**
   * Pre-rendered text representation of the entity.
   * Built by renderEntityText() — a pure function defined per entityType.
   * Example for a PullRequest:
   *   "github:pull_request Title: Add OAuth login Body: This PR adds ... Labels: auth,security"
   */
  text: string;
  workspaceId: string;
  orgId: string;
  connectionId: string;
}

// ---------------------------------------------------------------------------
// Inngest event types — exported so tests can assert shape compliance
// ---------------------------------------------------------------------------

/** Data shape of the `"ingestion/entity.received"` Inngest event. */
export interface IngestionEntityReceived {
  connectionId: string;
  workspaceId: string;
  orgId: string;
  /** Connector slug: "github" | "google-drive" | "zoom" | etc. */
  connectorType: string;
  /** Raw record type from the source: "pull_request" | "issue" | "file" | etc. */
  sourceRecordType: string;
  /**
   * Stable idempotency key.
   * Convention: `{connectorType}:{connectionId}:{sourceRecordType}:{timestamp}`
   */
  idempotencyKey: string;
  payload: unknown;
  receivedAt: string; // ISO-8601
}

// ---------------------------------------------------------------------------
// Overall pipeline result (returned by runPipeline)
// ---------------------------------------------------------------------------

export interface PipelineResult {
  naturalKey: string;
  operation: EntityOperation;
  dedup: DeduplicationResult;
  embedded: boolean;
  /** Conformance score (0.0–1.0) of the written node, when a schema was pinned. */
  conformanceScore?: number;
}

// Re-export the active-vocabulary contract so pipeline callers thread one type.
export type {
  PinnedSchema,
  PinnedLabel,
  PinnedRelationshipType,
  PinnedProperty,
} from "./validate/schema";
