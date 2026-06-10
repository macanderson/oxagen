import type { CapabilityHandler } from "@oxagen/oxagen";
import { connectionPreview } from "@oxagen/oxagen/contracts/connection.preview";
import { schema, withTenantDb } from "@oxagen/database";
import { eq, and } from "drizzle-orm";
import { createIngestionCryptoAdapter, decrypt } from "@oxagen/crypto";
import { getConnector } from "@oxagen/ingestion/connectors";
import type { AuthCredential } from "@oxagen/ingestion/connectors";
import { HTTPException } from "hono/http-exception";
import { logger } from "./logger";

export const connectionPreviewHandler: CapabilityHandler<typeof connectionPreview> = async (
  input,
  ctx,
) => {
  // Fetch source connection + auth credentials in one query
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.sourceConnections.id,
        connectorId: schema.sourceConnections.connectorId,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
        orgId: schema.sourceConnections.orgId,
        workspaceId: schema.sourceConnections.workspaceId,
        encryptedPayload: schema.authCredentials.encryptedPayload,
      })
      .from(schema.sourceConnections)
      .innerJoin(
        schema.authCredentials,
        eq(schema.authCredentials.connectionId, schema.sourceConnections.id),
      )
      .where(
        and(
          eq(schema.sourceConnections.publicId, input.connectionId),
          eq(schema.sourceConnections.orgId, ctx.orgId),
          eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
        ),
      )
      .limit(1),
  );

  const row = rows[0];
  if (!row) {
    logger.warn(
      { connectionId: input.connectionId, orgId: ctx.orgId },
      "connection.preview: not found",
    );
    throw new HTTPException(404, { message: "Connection not found" });
  }

  // Decrypt auth credentials
  const { adapter, keyId } = createIngestionCryptoAdapter();
  const envelope = row.encryptedPayload as { keyId: string; ciphertext: string };
  const cipherBuf = Buffer.from(envelope.ciphertext, "base64");
  const plaintext = await decrypt(cipherBuf, keyId, { adapter });
  const authCredential = JSON.parse(plaintext) as AuthCredential;

  // Load connector and fetch preview data
  const connector = getConnector(row.connectorId);
  const deliveryConfig = (row.deliveryConfig ?? {}) as Record<string, unknown>;

  logger.info(
    { connectionId: row.id, connectorId: row.connectorId, orgId: ctx.orgId },
    "connection.preview: fetching record type samples",
  );

  const samples = await connector.previewRecordTypes(authCredential, deliveryConfig);

  return {
    recordTypes: samples.map((sample) => ({
      sourceRecordType: sample.sourceRecordType,
      displayName: sample.displayName,
      sampleCount: sample.sampleRecords.length,
      sampleFields: Object.keys(sample.fieldSchema),
      sampleRecords: sample.sampleRecords.slice(0, 3) as Array<Record<string, unknown>>,
    })),
  };
};
