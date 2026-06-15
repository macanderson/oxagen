import { z } from "zod";

// How the connector authenticates with the source.
export type AuthScheme =
  | "public"
  | "api_key"
  | "api_key_secret"
  | "bearer_token"
  | "basic_auth"
  | "connection_string"
  | "oauth2_authorization_code"
  | "oauth2_client_credentials"
  | "service_account_json"
  | "aws_cross_account_role"
  | "aws_iam_keys"
  | "ssh_private_key"
  | "rsa_key_pair"
  | "tls_mutual";

// How data moves from the source to Oxagen.
export type DeliveryMethod =
  | "webhook"
  | "rest_polling"
  | "graphql_polling"
  | "sql_query"
  | "nosql_query"
  | "file_source"
  | "kafka"
  | "pubsub"
  | "eventbridge"
  | "cdc";

// Discriminated union of encrypted credential blobs stored in auth_credentials.
// The oauth2 variant is a marker only — actual tokens live in oauth_tokens.
export type AuthCredential =
  | { scheme: "public" }
  | { scheme: "api_key"; apiKey: string }
  | { scheme: "api_key_secret"; apiKey: string; apiSecret: string }
  | { scheme: "bearer_token"; token: string }
  | { scheme: "basic_auth"; username: string; password: string }
  | { scheme: "connection_string"; connectionString: string }
  | { scheme: "service_account_json"; serviceAccountJson: string }
  | { scheme: "aws_cross_account_role"; roleArn: string; externalId: string; region: string }
  | { scheme: "aws_iam_keys"; accessKeyId: string; secretAccessKey: string; region: string; sessionToken?: string }
  | { scheme: "ssh_private_key"; privateKeyPem: string; passphrase?: string; username: string; host: string; port: number }
  | { scheme: "rsa_key_pair"; privateKeyPem: string; passphrase?: string }
  | { scheme: "tls_mutual"; certPem: string; privateKeyPem: string; caPem?: string }
  | { scheme: "oauth2"; _marker: "oauth2" };

// Sample records fetched during setup wizard preview — one per source record type.
export interface RecordTypeSample {
  sourceRecordType: string;
  displayName: string;
  sampleRecords: unknown[];
  totalCount?: number;
  // Field path → JS type string, rendered in the property mapping UI.
  fieldSchema: Record<string, string>;
}

// Output of normalizeRecord() — flat properties, no entity type knowledge.
export interface NormalizedRecord {
  externalId: string;
  externalUrl?: string;
  displayName?: string;
  properties: Record<string, unknown>;
}

// A single raw record from the source before normalization.
export interface RawRecord {
  sourceRecordType: string;
  externalId: string;
  raw: unknown;
  receivedAt: string; // ISO-8601
}

// One ingestable record extracted from a raw webhook delivery. `record` is the
// sub-object ready to hand to normalizeRecord(sourceRecordType, record) — e.g.
// for a GitHub `pull_request` event this is payload.pull_request, and for a
// `push` event one entry per commit (reshaped into the connector's commit shape).
export interface WebhookExtraction {
  sourceRecordType: string;
  record: unknown;
}

export interface ConnectorDefinition<TConfig extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly connectorId: string;
  readonly displayName: string;
  readonly description: string;
  readonly icon: string;
  readonly supportedAuthSchemes: AuthScheme[];
  readonly deliveryMethod: DeliveryMethod;
  readonly defaultPollIntervalSeconds?: number;
  // Non-auth connection config (repos to sync, query, bucket name, etc.).
  readonly connectionConfigSchema: TConfig;

  // Called during setup wizard — fetches sample records per source record type.
  previewRecordTypes(
    auth: AuthCredential,
    config: z.infer<TConfig>,
  ): Promise<RecordTypeSample[]>;

  // Pure field extraction: raw API record → NormalizedRecord.
  // No entity type knowledge — that mapping lives in ingestion.entity_type_mappings.
  normalizeRecord(sourceRecordType: string, raw: unknown): NormalizedRecord;

  // Optional: translate a raw webhook delivery (the provider's event name + the
  // full JSON payload) into zero or more ingestable records. Each returned
  // sourceRecordType must be one this connector's normalizeRecord() understands.
  // Returns [] for events the connector does not ingest (pings, lifecycle, etc.).
  parseWebhookEvent?(eventName: string, payload: unknown): WebhookExtraction[];

  // Optional: subscribe to webhooks at the source after the connection goes active.
  subscribeWebhooks?(
    auth: AuthCredential,
    config: z.infer<TConfig>,
    webhookUrl: string,
  ): Promise<{ subscriptionId: string; secret?: string }>;

  // Optional: poll-based ingestor for sources without webhooks.
  poll?(
    auth: AuthCredential,
    config: z.infer<TConfig>,
    recordType: string,
    cursor: string | null,
  ): AsyncIterable<RawRecord>;

  // Optional: verify inbound webhook signature before normalizing.
  verifyWebhook?(
    payload: Uint8Array,
    headers: Record<string, string>,
    secret: string | null,
  ): boolean;
}

// Connector registrations are module-level side effects reachable through
// both the package "." barrel and the "./connectors" subpath export, and
// Next's RSC/SSR module graphs (plus dev HMR) can evaluate those modules more
// than once. Anchor the registry on globalThis and treat re-registration of
// the same connectorId as benign — keep the first — mirroring the capability
// registry in @oxagen/oxagen/registry.
const REGISTRY_KEY = Symbol.for("@oxagen/ingestion.connectorRegistry");

type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, ConnectorDefinition>;
};

const globalRef = globalThis as GlobalWithRegistry;
const registry: Map<string, ConnectorDefinition> =
  globalRef[REGISTRY_KEY] ??
  (globalRef[REGISTRY_KEY] = new Map<string, ConnectorDefinition>());

export function registerConnector(connector: ConnectorDefinition): void {
  if (registry.has(connector.connectorId)) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[ingestion] Connector "${connector.connectorId}" re-registered; ` +
          `keeping the first registration (likely a dev bundler/HMR artifact).`,
      );
    }
    return;
  }
  registry.set(connector.connectorId, connector);
}

export function getConnector(connectorId: string): ConnectorDefinition {
  const c = registry.get(connectorId);
  if (!c) throw new Error(`No connector registered for "${connectorId}"`);
  return c;
}

export function listConnectors(): ConnectorDefinition[] {
  return Array.from(registry.values());
}
