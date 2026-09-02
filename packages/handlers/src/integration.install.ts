import type { CapabilityHandler } from "@oxagen/oxagen";
import { integrationInstall } from "@oxagen/oxagen/contracts/integration.install";
import { schema, withTenantDb } from "@oxagen/database";
import { getConnector } from "@oxagen/ingestion/connectors";
import { HTTPException } from "hono/http-exception";
import type { ConnectorDefinition } from "@oxagen/ingestion/connectors";
import { logger } from "./logger";

/**
 * integration.install — install a plugin (connector) instance into the current
 * workspace. An integration instance is an `ingestion.source_connections` row
 * (matching the shipped integration.sync/configure/metrics convention).
 *
 * Flow:
 *   1. Resolve the connector by pluginId (the @oxagen/ingestion registry). An
 *      unknown plugin is a 404 — not a server error.
 *   2. Validate `input.config` against the connector's own Zod
 *      connectionConfigSchema (real schema validation, every connector). Invalid
 *      config is a 422 listing the offending fields.
 *   3. Insert the connection in `pending_setup` — the same initial state as
 *      connection.create. Authentication (OAuth / secrets via the connection
 *      wizard) and the first ingestion run (repo.sync / integration.sync) are
 *      deliberately subsequent steps, so no Inngest job is dispatched here: a
 *      fabricated "syncing" event would lie about work that hasn't been queued.
 *      The returned jobId references the created instance for traceability.
 *
 * Custom partner plugins (schemaUrl) are not yet installable — partner schema
 * fetch is unimplemented platform-wide (see plugin.schema.get). An unknown
 * pluginId therefore 404s regardless of schemaUrl rather than silently
 * pretending to install.
 */
export const integrationInstallHandler: CapabilityHandler<
  typeof integrationInstall
> = async (input, ctx) => {
  if (!ctx.userId) {
    throw new HTTPException(401, {
      message: "integration.install requires an authenticated user",
    });
  }

  let connector: ConnectorDefinition;
  try {
    connector = getConnector(input.pluginId);
  } catch {
    logger.warn(
      { pluginId: input.pluginId, orgId: ctx.orgId },
      "integration.install: unknown plugin",
    );
    throw new HTTPException(404, {
      message: `Unknown plugin: ${input.pluginId}`,
    });
  }

  // Validate the supplied config against the connector's declared schema.
  const parsed = connector.connectionConfigSchema.safeParse(input.config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new HTTPException(422, {
      message: `Invalid plugin config: ${issues}`,
    });
  }

  const authScheme = connector.supportedAuthSchemes[0] ?? "public";

  const row = await withTenantDb(async (tx) => {
    const [conn] = await tx
      .insert(schema.sourceConnections)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        connectorId: input.pluginId,
        displayName: input.displayName,
        authScheme,
        deliveryMethod: connector.deliveryMethod,
        deliveryConfig: parsed.data as Record<string, unknown>,
        status: "pending_setup",
        createdByUserId: ctx.userId ?? undefined,
        updatedByUserId: ctx.userId ?? undefined,
      })
      .returning({
        id: schema.sourceConnections.id,
        publicId: schema.sourceConnections.publicId,
      });
    if (!conn) throw new Error("integration.install: insert returned no row");
    return conn;
  });

  const jobId = `job_install_${row.publicId}`;

  logger.info(
    {
      jobId,
      integrationId: row.publicId,
      connectionId: row.id,
      pluginId: input.pluginId,
      displayName: input.displayName,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    "integration.install: instance created (pending_setup)",
  );

  return {
    jobId,
    status: "queued" as const,
    pluginId: input.pluginId,
    displayName: input.displayName,
  };
};
