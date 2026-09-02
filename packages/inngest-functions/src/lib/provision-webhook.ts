import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { createIngestionCryptoAdapter, encrypt } from "@oxagen/crypto";
import { getConnector } from "@oxagen/ingestion/connectors";
import { logger } from "../logger";
import { resolveConnectionAuth } from "./resolve-connection-auth";

// Shared webhook-subscription provisioning + renewal core.
//
// A webhook-declared connector (deliveryMethod: "webhook" + subscribeWebhooks)
// only receives deliveries once it has an active provider subscription AND a
// stored HMAC/channel secret. The delivery route (apps/api webhook.ts) joins
// ingestion.webhook_subscriptions and rejects a delivery with no secret, so
// this module is what makes the row exist: it resolves the connection's OAuth
// token, asks the connector to register (or re-register) the provider
// subscription, encrypts the returned secret to the {keyId, ciphertext}
// envelope the route decrypts, and upserts the row keyed by webhook_path
// (unique). Both first-time provisioning and cron renewal call
// provisionWebhookSubscription — re-subscription is idempotent per connection.

type Envelope = { keyId: string; ciphertext: string };

async function encryptToEnvelope(plaintext: string): Promise<Envelope> {
  const writeAdapter = createIngestionCryptoAdapter();
  const cipher = await encrypt(plaintext, writeAdapter.keyId, {
    adapter: writeAdapter.adapter,
  });
  return { keyId: writeAdapter.keyId, ciphertext: cipher.toString("base64") };
}

/**
 * The API base the provider posts deliveries to. The delivery route is mounted
 * at POST /webhooks/:connectorId/:connectionId (apps/api), so the full URL is
 * `${OXAGEN_API_URL}/webhooks/${connectorId}/${connectionPublicId}`.
 */
function webhookUrlFor(
  connectorId: string,
  connectionPublicId: string,
): string {
  // The public API base the provider posts to. Falls back to the prod host so a
  // provisioning run never registers a localhost URL by accident in prod.
  const base = (
    process.env["OXAGEN_API_URL"] ?? "https://api.oxagen.sh"
  ).replace(/\/+$/, "");
  return `${base}/webhooks/${connectorId}/${connectionPublicId}`;
}

/** The stored webhook_path — the tenant-opaque per-connection delivery path. */
function webhookPathFor(
  connectorId: string,
  connectionPublicId: string,
): string {
  return `/webhooks/${connectorId}/${connectionPublicId}`;
}

interface ConnectionRow {
  id: string;
  public_id: string;
  connector_id: string;
  delivery_config: Record<string, unknown> | null;
  status: string;
}

export interface ProvisionResult {
  outcome: "subscribed" | "skipped" | "unsupported";
  reason?: string;
  webhookSubscriptionId?: string;
  providerSubscriptionId?: string;
  expiresAt?: string | null;
}

/**
 * Provision (or renew) the webhook subscription for one connection. Idempotent:
 * safe to call on first activation and on every renewal tick. Returns a
 * structured outcome instead of throwing on the expected "not a webhook
 * connector" / "no credential" paths so the caller (cron/step) can continue.
 *
 * Throws only on genuine, retryable infrastructure failures (the provider call
 * or the DB write) so Inngest retries them.
 */
export async function provisionWebhookSubscription(
  connectionId: string,
  orgId: string,
): Promise<ProvisionResult> {
  // Load the connection shell.
  const connRows = await withSystemDb(async (tx) => {
    const rows = await tx.execute(sql`
      SELECT id, public_id, connector_id, delivery_config, status
      FROM   ingestion.source_connections
      WHERE  id     = ${connectionId}::uuid
      AND    org_id = ${orgId}::uuid
      AND    deleted_at IS NULL
      LIMIT  1
    `);
    return Array.from(rows) as unknown as ConnectionRow[];
  });
  const conn = connRows[0];
  if (!conn) {
    return { outcome: "skipped", reason: "connection_not_found" };
  }

  // Only webhook connectors with a subscribeWebhooks implementation provision.
  let connector: ReturnType<typeof getConnector>;
  try {
    connector = getConnector(conn.connector_id);
  } catch {
    return { outcome: "skipped", reason: "unknown_connector" };
  }
  if (
    connector.deliveryMethod !== "webhook" ||
    typeof connector.subscribeWebhooks !== "function"
  ) {
    return { outcome: "unsupported", reason: "connector_has_no_subscribe" };
  }

  // Resolve the connection's OAuth/bearer credential (refreshes if near expiry).
  const resolved = await resolveConnectionAuth(connectionId, orgId);
  if (!resolved) {
    // No usable credential — the connection needs a reconnect. Not retryable
    // as a provisioning failure; the credential resolver already degraded health.
    return { outcome: "skipped", reason: "no_usable_credential" };
  }

  // Validate the stored delivery_config against the connector's schema so the
  // connector receives a typed config object.
  const parsedConfig = connector.connectionConfigSchema.safeParse(
    conn.delivery_config ?? {},
  );
  if (!parsedConfig.success) {
    return { outcome: "skipped", reason: "invalid_connection_config" };
  }

  const webhookUrl = webhookUrlFor(conn.connector_id, conn.public_id);
  const webhookPath = webhookPathFor(conn.connector_id, conn.public_id);

  // Register with the provider (throws on a real HTTP failure → Inngest retry).
  const result = await connector.subscribeWebhooks(
    resolved.auth,
    parsedConfig.data,
    webhookUrl,
  );

  // Encrypt the shared secret at rest (only when the connector returned one).
  const secretEnc = result.secret
    ? await encryptToEnvelope(result.secret)
    : null;

  // Upsert on the unique webhook_path so renewal updates the existing row rather
  // than inserting a duplicate. public_id is minted per row for a new insert.
  const publicId = `whs_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
  const upserted = await withSystemDb(async (tx) => {
    const rows = await tx.execute(sql`
      INSERT INTO ingestion.webhook_subscriptions (
        public_id, connection_id, webhook_path, secret_enc,
        hmac_algorithm, hmac_header, provider_subscription_id,
        record_types, status, expires_at, updated_at
      ) VALUES (
        ${publicId},
        ${connectionId}::uuid,
        ${webhookPath},
        ${secretEnc ? JSON.stringify(secretEnc) : null}::jsonb,
        ${result.hmacAlgorithm ?? null},
        ${result.hmacHeader ?? null},
        ${result.subscriptionId},
        ${sql.param([...(result.recordTypes ?? [])])}::text[],
        'active',
        ${result.expiresAt ? result.expiresAt.toISOString() : null},
        NOW()
      )
      ON CONFLICT (webhook_path) DO UPDATE SET
        secret_enc               = EXCLUDED.secret_enc,
        hmac_algorithm           = EXCLUDED.hmac_algorithm,
        hmac_header              = EXCLUDED.hmac_header,
        provider_subscription_id = EXCLUDED.provider_subscription_id,
        record_types             = EXCLUDED.record_types,
        status                   = 'active',
        expires_at               = EXCLUDED.expires_at,
        updated_at               = NOW()
      RETURNING id, expires_at
    `);
    return Array.from(rows) as Array<{ id: string; expires_at: string | null }>;
  });

  const row = upserted[0];
  logger.info(
    {
      connectionId,
      connectorId: conn.connector_id,
      providerSubscriptionId: result.subscriptionId,
      expiresAt: result.expiresAt?.toISOString() ?? null,
    },
    "provision-webhook: subscription provisioned",
  );

  return {
    outcome: "subscribed",
    webhookSubscriptionId: row?.id,
    providerSubscriptionId: result.subscriptionId,
    expiresAt: row?.expires_at ?? null,
  };
}
