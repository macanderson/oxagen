/**
 * ConnectorPlugin interface — every data source implements this.
 *
 * A connector is a pure transformation layer:
 *   - configSchema:  Zod schema for the workspace connection config
 *   - normalize():   raw source event → EntityMutation (or null to skip)
 *   - ingest():      optional poller that yields RawIngestEvents on a schedule
 *
 * Connectors do NOT handle deduplication, embedding, or graph writes.
 * The universal pipeline handles all of that. A connector author's only job
 * is to describe what entities the source produces and how to normalize them.
 */

import { z } from "zod";
import type { RawIngestEvent, EntityMutation } from "../types";

// Auth methods a connector can declare it supports.
export const AuthMethodSchema = z.enum([
  "api_key",
  "bearer_token",
  "basic_auth",
  "oauth2_authorization_code",
  "oauth2_client_credentials",
  "github_app",
  "webhook_secret",     // inbound webhooks verified by HMAC
  "connection_string",  // SQL/NoSQL direct connections
  "sftp_key",
]);
export type AuthMethod = z.infer<typeof AuthMethodSchema>;

// How a connector delivers data to the pipeline.
export const SyncStrategySchema = z.enum([
  "webhook",    // source pushes events; connector verifies + queues
  "polling",    // connector calls source API on interval; yields events
  "batch",      // connector bulk-exports data on a schedule
  "realtime",   // streaming connection (OTEL OTLP, CDC, etc.)
]);
export type SyncStrategy = z.infer<typeof SyncStrategySchema>;

/**
 * Connector manifest — static metadata registered at build time.
 * The registry uses this to render the setup UI, validate configs,
 * and route incoming webhooks to the right connector.
 */
export interface ConnectorManifest<TConfig extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Unique slug — used as the URL path segment for webhooks and as the DB record type. */
  readonly type: string;
  readonly displayName: string;
  readonly description: string;
  readonly icon: string; // icon name from the design system icon set
  /** Zod schema auto-generates the config form in the workspace connector UI. */
  readonly configSchema: TConfig;
  readonly authMethods: AuthMethod[];
  readonly syncStrategies: SyncStrategy[];
  /**
   * Which Neo4j node types this connector can produce.
   * Declared statically so the UI and deduplication engine know what to expect.
   */
  readonly entityTypes: string[];
}

/**
 * ConnectorPlugin — the full runtime interface every connector implements.
 * TConfig is the Zod schema type for the connector's configuration.
 */
export interface ConnectorPlugin<TConfig extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly manifest: ConnectorManifest<TConfig>;

  /**
   * Normalize a raw source event into a typed EntityMutation.
   *
   * Return null to silently skip the event (e.g. a GitHub event type the
   * connector doesn't handle, or a filtered-out repository).
   *
   * This function MUST be pure and synchronous — no network calls, no DB access.
   * Any enrichment that requires IO happens in Stage 4 (inference workers).
   */
  normalize(event: RawIngestEvent): EntityMutation | null;

  /**
   * Optional polling ingestor. Implement when the source doesn't support
   * webhooks (e.g. custom SQL with an `updated_at` column, batch file exports).
   *
   * The cursor is the last sync position (a timestamp, page token, or sequence
   * number). The pipeline persists it to Postgres after each yielded event is
   * successfully queued.
   *
   * yield → pipeline Stage 1 → normalize → dedup → embed → infer
   */
  ingest?(config: z.infer<TConfig>, cursor: string | null): AsyncIterable<RawIngestEvent>;

  /**
   * Optional webhook verifier. Called before normalize() for inbound webhooks.
   * Return true if the signature is valid, false to reject the request (HTTP 401).
   *
   * If not implemented, the pipeline accepts all inbound events for this connector
   * (appropriate only for connectors that use a different auth layer).
   */
  verifyWebhookSignature?(
    payload: Uint8Array,
    headers: Record<string, string>,
    config: z.infer<TConfig>,
  ): boolean;
}

/**
 * Connector registry — all installed connectors are registered here.
 * Connectors register themselves by calling registerConnector() at module load.
 */
const registry = new Map<string, ConnectorPlugin>();

export function registerConnector(connector: ConnectorPlugin): void {
  if (registry.has(connector.manifest.type)) {
    throw new Error(`Connector type "${connector.manifest.type}" is already registered`);
  }
  registry.set(connector.manifest.type, connector);
}

export function getConnector(type: string): ConnectorPlugin {
  const connector = registry.get(type);
  if (!connector) throw new Error(`No connector registered for type "${type}"`);
  return connector;
}

export function listConnectors(): ConnectorPlugin[] {
  return Array.from(registry.values());
}
