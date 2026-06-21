import type { CapabilityHandler } from "@oxagen/oxagen";
import { connectionCreate } from "@oxagen/oxagen/contracts/connection.create";
import { schema, withTenantDb } from "@oxagen/database";
import { encrypt } from "@oxagen/crypto";
import { createIngestionCryptoAdapter } from "@oxagen/crypto";
import { getConnector } from "@oxagen/ingestion/connectors";
import { logger } from "./logger";

export const connectionCreateHandler: CapabilityHandler<typeof connectionCreate> = async (
  input,
  ctx,
) => {
  if (!ctx.userId) {
    throw new Error("connection.create requires an authenticated user");
  }

  // Validate connector exists before touching the DB
  const connector = getConnector(input.connectorId);
  const deliveryMethod = input.deliveryMethod ?? connector.deliveryMethod;

  // Encrypt auth credentials before storage
  const { adapter, keyId } = createIngestionCryptoAdapter();
  const plaintext = JSON.stringify(input.authCredential);
  const cipherBuf = await encrypt(plaintext, keyId, { adapter });
  const encryptedPayload = { keyId, ciphertext: cipherBuf.toString("base64") };

  const authScheme = (input.authCredential["type"] as string) ?? "api_key";

  // Insert the connection row and its encrypted credentials atomically in a
  // single transaction. A two-call approach would leave an orphaned
  // pending_setup connection with no credentials if the credential insert
  // failed (constraint violation, transient error, or crash), breaking every
  // later preview/sync/decrypt path.
  const row = await withTenantDb(async (tx) => {
    const [conn] = await tx
      .insert(schema.sourceConnections)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        connectorId: input.connectorId,
        displayName: input.displayName,
        authScheme,
        deliveryMethod,
        deliveryConfig: input.connectionConfig ?? null,
        status: "pending_setup",
      })
      .returning({
        id: schema.sourceConnections.id,
        publicId: schema.sourceConnections.publicId,
        connectorId: schema.sourceConnections.connectorId,
        displayName: schema.sourceConnections.displayName,
        status: schema.sourceConnections.status,
      });

    if (!conn) throw new Error("connection.create: insert returned no row");

    await tx.insert(schema.authCredentials).values({
      connectionId: conn.id,
      authScheme,
      encryptedPayload,
    });

    return conn;
  });

  logger.info(
    {
      connectionId: row.id,
      publicId: row.publicId,
      connectorId: row.connectorId,
      orgId: ctx.orgId,
    },
    "connection.create: created connection",
  );

  return {
    connectionId: row.id,
    publicId: row.publicId,
    status: "pending_setup" as const,
    connectorId: row.connectorId,
    displayName: row.displayName,
  };
};
