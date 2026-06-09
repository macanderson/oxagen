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

const registry = new Map<string, ConnectorDefinition>();

export function registerConnector(connector: ConnectorDefinition): void {
  if (registry.has(connector.connectorId)) {
    throw new Error(`Connector "${connector.connectorId}" is already registered`);
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
