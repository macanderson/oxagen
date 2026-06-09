/**
 * Universal ingestion pipeline types.
 *
 * Every data source connector — GitHub, Linear, Stripe, custom SQL, custom
 * NoSQL, Google Drive, Salesforce, etc. — produces EntityMutations that flow
 * through exactly these stages:
 *
 *   1. Receive   RawIngestEvent arrives (webhook or poller)
 *   2. Normalize  connector.normalize() → EntityMutation
 *   3. Dedup      naturalKey lookup → match existing node OR create principal
 *                 embedding similarity → ALIAS_OF edge with confidence score
 *   4. Embed      embedText() → store vector on Neo4j node
 *   5. Infer      async LLM worker → infer semantic edges and feature membership
 *
 * Stages fire each other via Inngest. Each stage is independently retryable.
 * Ingested entity nodes live 100% in Neo4j — no Postgres dual-write. If Neo4j
 * is temporarily unavailable Inngest retries with a 24 h window. Postgres holds
 * only connector credentials (encrypted) and connection config.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Stage 1 — Raw event (one per entity mutation from any source)
// ---------------------------------------------------------------------------

export interface RawIngestEvent {
  /** Which registered workspace connection produced this event. */
  connectionId: string;
  workspaceId: string;
  orgId: string;
  /** Connector type slug: "github" | "linear" | "stripe" | "custom-sql" | etc. */
  connectorType: string;
  /**
   * Stable idempotency key. Connectors must produce a deterministic key so
   * webhook replays and polling overlaps are silently dropped.
   * Convention: `{connectorType}:{connectionId}:{externalId}:{eventType}:{hash}`
   */
  idempotencyKey: string;
  /** Raw payload from the source system — unvalidated, connector-specific. */
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
   * Target Neo4j node label. Maps to NodeLabels constants.
   * Connectors declare which entityTypes they emit in their manifest.
   */
  entityType: string;
  /**
   * Stable, globally unique deduplication key.
   * Convention: `{connectorType}:{entityType}:{connectionId}:{externalId}`
   * Example:    `github:PullRequest:conn_abc:octocat/hello-world:42`
   */
  naturalKey: string;
  operation: EntityOperation;
  /**
   * Human-readable label used in deduplication name-matching and UI display.
   * For a person: full name. For a PR: title. For an issue: title.
   */
  displayName?: string;
  /** Validated, connector-specific properties. Zod-coerced by normalize(). */
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
  | "natural_key_exact"    // same externalId from same connector type
  | "email_match"          // identical email property
  | "url_match"            // identical canonical URL
  | "name_embedding"       // high-cosine-similarity on display name
  | "property_embedding"   // high-cosine-similarity on full property vector
  | "cross_source_id"      // explicit cross-system ID hint (e.g. GitHub login in Linear profile)
  | "human_confirmed";     // a workspace user approved the alias

export interface DeduplicationResult {
  /** Neo4j publicId of the canonical (principal) node. */
  principalNodeId: string;
  /** Neo4j publicId of a new alias node, if action === "created_alias". */
  aliasNodeId?: string;
  action: DeduplicationAction;
  /**
   * Confidence that this entity IS the same real-world entity as the principal.
   * Range: 0.0–1.0.
   * >= ALIAS_THRESHOLD (0.70)    → create alias
   * >= CONFIRM_THRESHOLD (0.92)  → auto-confirm alias (skip human review)
   */
  confidence: number;
  matchReason?: AliasMatchReason;
}

export const ALIAS_THRESHOLD = 0.70;
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
// Stage 5 — Semantic inference
// ---------------------------------------------------------------------------

export interface SemanticInferenceJob {
  /** Neo4j publicId of the node that triggered inference. */
  nodeId: string;
  entityType: string;
  /** Snapshot of key properties — prevents a second Neo4j read in the worker. */
  propertiesSnapshot: Record<string, unknown>;
  workspaceId: string;
  orgId: string;
  /**
   * Number of graph hops to include as context for the inference LLM call.
   * Default: 1. Increase for entities with sparse direct properties (e.g. a
   * commit with only a SHA — hop to the PR and feature for context).
   */
  contextHops?: number;
}

/**
 * Output of a single semantic inference pass.
 * The worker may infer N edges and/or N new nodes (e.g. inferring that a
 * commit "implements" a Feature, or that two Issues describe the same bug).
 */
export interface InferenceOutput {
  nodeId: string;
  inferredEdges: Array<{
    targetNodeId: string;
    edgeType: string;        // must be in EdgeTypes registry
    confidence: number;
    properties?: Record<string, unknown>;
  }>;
  inferredNodes: Array<{
    entityType: string;
    naturalKey: string;
    displayName: string;
    properties: Record<string, unknown>;
    confidence: number;
  }>;
}

// ---------------------------------------------------------------------------
// Overall pipeline result (returned by runPipeline)
// ---------------------------------------------------------------------------

export interface PipelineResult {
  naturalKey: string;
  operation: EntityOperation;
  dedup: DeduplicationResult;
  embedded: boolean;
  inferenceQueued: boolean;
}
