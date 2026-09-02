import { Hono } from "hono";
import { schema, withSystemDb } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import { eventClient } from "../../event-client";
import { getConnector } from "@oxagen/ingestion/connectors";
import { decrypt, resolveIngestionCryptoAdapterForKeyId } from "@oxagen/crypto";
import { logger } from "../../middleware/logger";
import type { AppEnv } from "../../app";

type WebhookConnRow = {
  connectionId: string;
  orgId: string;
  workspaceId: string;
  status: string;
  secretEnc: unknown;
};

export const webhookRoute = new Hono<AppEnv>();

// POST /webhooks/:connectorId/:connectionId
// Unauthenticated entry point for connector webhook deliveries.
// HMAC validation is the security boundary — each connector verifies its own signature.
webhookRoute.post("/:connectorId/:connectionId", async (c) => {
  const connectorId = c.req.param("connectorId");
  const connectionPublicId = c.req.param("connectionId");

  // MS Graph lifecycle validation: echo validationToken back as text/plain
  const validationToken = c.req.query("validationToken");
  if (validationToken) {
    return c.text(validationToken, 200, { "Content-Type": "text/plain" });
  }

  // Read raw body for HMAC verification — must read before any other parsing
  const rawBody = await c.req.arrayBuffer();
  const payload = new Uint8Array(rawBody);

  // Load connector — 404 if unknown connector slug
  let connector: ReturnType<typeof getConnector> | null = null;
  try {
    connector = getConnector(connectorId);
  } catch {
    return c.json({ error: "Unknown connector" }, 404);
  }

  // Look up the connection and its HMAC secret. withSystemDb is correct here:
  // this is an unauthenticated route with no ALS scope, and we need to resolve
  // the tenant from the connection's publicId before any scope exists.
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        connectionId: schema.sourceConnections.id,
        orgId: schema.sourceConnections.orgId,
        workspaceId: schema.sourceConnections.workspaceId,
        status: schema.sourceConnections.status,
        secretEnc: schema.webhookSubscriptions.secretEnc,
      })
      .from(schema.sourceConnections)
      .leftJoin(
        schema.webhookSubscriptions,
        and(
          eq(
            schema.webhookSubscriptions.connectionId,
            schema.sourceConnections.id,
          ),
          isNull(schema.sourceConnections.deletedAt),
        ),
      )
      .where(
        and(
          eq(schema.sourceConnections.publicId, connectionPublicId),
          isNull(schema.sourceConnections.deletedAt),
        ),
      )
      .limit(1),
  );

  const conn = rows[0] as WebhookConnRow | undefined;
  if (!conn) {
    return c.json({ error: "Connection not found" }, 404);
  }

  // Decrypt HMAC / channel-token signing secret. A secret is stored (conn.secretEnc
  // present) but cannot be decrypted only on a key-management failure (missing
  // INGESTION_ENCRYPTION_KEY, corrupted ciphertext, adapter misconfiguration). That
  // is NOT a verification failure to be silently swallowed — proceeding without the
  // secret would degrade the gate to unauthenticated for connectors that treat a
  // null secret as "no secret configured". Log and fail closed (500) instead.
  let webhookSecret: string | undefined;
  if (conn.secretEnc) {
    try {
      const enc = conn.secretEnc as { keyId: string; ciphertext: string };
      // Route by the envelope's stored keyId, not the current provider env var,
      // so a secret wrapped under a previous INGESTION_CRYPTO_PROVIDER still decrypts.
      const { adapter } = resolveIngestionCryptoAdapterForKeyId(enc.keyId);
      const plain = await decrypt(
        Buffer.from(enc.ciphertext, "base64"),
        enc.keyId,
        { adapter },
      );
      webhookSecret = plain.toString("utf8");
    } catch (err) {
      logger.error(
        {
          connectorId,
          connectionId: conn.connectionId,
          err: err instanceof Error ? err.message : String(err),
        },
        "webhook secret decryption failed — rejecting delivery (fail closed)",
      );
      return c.json({ error: "Webhook secret unavailable" }, 500);
    }
  }

  // Build header map for connector verification
  const headers: Record<string, string> = {};
  for (const [key, value] of c.req.raw.headers.entries()) {
    headers[key.toLowerCase()] = value;
  }

  // HMAC / token verification — connector decides the algorithm. This is the
  // security boundary, so it must default CLOSED: a connector that ships no
  // verifyWebhook implementation is an incomplete/misconfigured webhook connector,
  // and we reject rather than admit unverified payloads into the ingestion pipeline.
  if (typeof connector.verifyWebhook !== "function") {
    logger.error(
      { connectorId, connectionId: conn.connectionId },
      "connector has no verifyWebhook implementation — rejecting delivery (fail closed)",
    );
    return c.json({ error: "Webhook verification unavailable" }, 401);
  }
  const verified = connector.verifyWebhook(
    payload,
    headers,
    webhookSecret ?? null,
  );
  if (!verified) {
    return c.json({ error: "Webhook signature invalid" }, 401);
  }

  // Parse payload as JSON for the Inngest event
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(Buffer.from(payload).toString("utf8"));
  } catch {
    parsedPayload = Buffer.from(payload).toString("utf8");
  }

  // Determine source record type from the delivery payload (connector-specific header or body field)
  const sourceRecordType =
    headers["x-github-event"] ??
    headers["x-linear-event"] ??
    headers["x-slack-event-type"] ??
    (typeof parsedPayload === "object" &&
    parsedPayload !== null &&
    "type" in parsedPayload &&
    typeof (parsedPayload as Record<string, unknown>)["type"] === "string"
      ? String((parsedPayload as Record<string, unknown>)["type"])
      : "event");

  // Fire Inngest pipeline event.
  //
  // NOTE on `idempotencyKey` below: the trailing `Date.now()` makes it unique
  // per delivery, so it does NOT dedupe a provider's at-least-once redelivery of
  // the same event — it only separates distinct deliveries that would otherwise
  // collide. Real dedupe needs the provider's own delivery id (GitHub's
  // `x-github-delivery`, Linear's `linear-delivery`, …); adding that changes
  // pipeline behaviour, so it is tracked rather than silently swapped in here.
  await eventClient.send({
    name: "ingestion/entity.received",
    data: {
      connectionId: conn.connectionId,
      workspaceId: conn.workspaceId,
      orgId: conn.orgId,
      connectorType: connectorId,
      sourceRecordType,
      idempotencyKey: `${connectorId}:${conn.connectionId}:${sourceRecordType}:${Date.now()}`,
      payload: parsedPayload,
      receivedAt: new Date().toISOString(),
    },
  });

  return c.json({ received: true }, 200);
});
