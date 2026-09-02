import type { CapabilityHandler } from "@oxagen/oxagen";
import { connectionPreview } from "@oxagen/oxagen/contracts/connection.preview";
import { schema, withTenantDb } from "@oxagen/database";
import { eq, and } from "drizzle-orm";
import { resolveIngestionCryptoAdapterForKeyId, decrypt } from "@oxagen/crypto";
import { getConnector } from "@oxagen/ingestion/connectors";
import type { AuthCredential } from "@oxagen/ingestion/connectors";
import { HTTPException } from "hono/http-exception";
import { logger } from "./logger";

export const connectionPreviewHandler: CapabilityHandler<
  typeof connectionPreview
> = async (input, ctx) => {
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

  // Decrypt auth credentials. Route the adapter by the envelope's stored keyId
  // (not the current provider env var) so credentials written under a previous
  // provider still decrypt after the deployment flips INGESTION_CRYPTO_PROVIDER.
  const envelope = row.encryptedPayload as {
    keyId: string;
    ciphertext: string;
  };
  const { adapter } = resolveIngestionCryptoAdapterForKeyId(envelope.keyId);
  const cipherBuf = Buffer.from(envelope.ciphertext, "base64");
  const plaintextBuf = await decrypt(cipherBuf, envelope.keyId, { adapter });
  const authCredential = JSON.parse(
    plaintextBuf.toString("utf8"),
  ) as AuthCredential;

  // Load connector and fetch preview data
  const connector = getConnector(row.connectorId);

  // Validate the stored config before handing it to the connector, exactly as
  // integration.install does on the way in. Without this the connector reads
  // whatever shape the row happens to hold and fails deep inside its own
  // logic: a `code` config field is stored as raw text, so custom-webhook hit
  // `config.recordTypes.map is not a function` and the wizard showed a bare
  // TypeError where a validation message belongs. Validating on read as well
  // as on write matters because a row outlives the schema that admitted it.
  const deliveryConfig = (row.deliveryConfig ?? {}) as Record<string, unknown>;
  const parsedConfig =
    connector.connectionConfigSchema.safeParse(deliveryConfig);
  if (!parsedConfig.success) {
    const issues = parsedConfig.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    logger.warn(
      {
        connectionId: row.id,
        connectorId: row.connectorId,
        orgId: ctx.orgId,
        issues,
      },
      "connection.preview: stored config does not satisfy the connector schema",
    );
    throw new HTTPException(422, {
      message: `This connection's configuration is not valid for ${row.connectorId}: ${issues}`,
    });
  }
  // The connector still receives the stored config, not `parsedConfig.data`:
  // parsing is the gate here, and handing over the parsed value would quietly
  // start applying schema defaults a caller never wrote.

  logger.info(
    { connectionId: row.id, connectorId: row.connectorId, orgId: ctx.orgId },
    "connection.preview: fetching record type samples",
  );

  const samples = await connector.previewRecordTypes(
    authCredential,
    deliveryConfig,
  );

  return {
    recordTypes: samples.map((sample) => ({
      sourceRecordType: sample.sourceRecordType,
      displayName: sample.displayName,
      sampleCount: sample.sampleRecords.length,
      sampleFields: Object.keys(sample.fieldSchema),
      sampleRecords: sample.sampleRecords.slice(0, 3) as Array<
        Record<string, unknown>
      >,
    })),
  };
};
