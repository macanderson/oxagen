import type { CapabilityHandler } from "@oxagen/oxagen";
import { pluginSchemaValidate } from "@oxagen/oxagen/contracts/plugin.schema.validate";
import type { ConnectorPluginSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";
import { HTTPException } from "hono/http-exception";
import {
  validateConfigAgainstSchema,
  type LoadedConnectorSchema,
} from "@oxagen/ingestion/connector-schema-loader";
import { pluginSchemaGetHandler } from "./plugin.schema.get";
import { logger } from "./logger";

export const pluginSchemaValidateHandler: CapabilityHandler<
  typeof pluginSchemaValidate
> = async (input, ctx) => {
  const { pluginId, authSchemeId, config } = input;

  // Resolve the schema — reuses the DB cache + file-loading logic.
  let pluginSchema: ConnectorPluginSchema;
  try {
    pluginSchema = await pluginSchemaGetHandler({ pluginId }, ctx);
  } catch (err) {
    if (err instanceof HTTPException && err.status === 404) {
      logger.warn({ pluginId }, "plugin.schema.validate: schema not found");
      throw err;
    }
    throw err;
  }

  const errors = validateConfigAgainstSchema(
    config as Record<string, unknown>,
    // ConnectorPluginSchema is structurally compatible with LoadedConnectorSchema.
    pluginSchema as unknown as LoadedConnectorSchema,
    authSchemeId,
  );

  const valid = errors.length === 0;

  logger.info(
    { pluginId, authSchemeId, valid, errorCount: errors.length },
    "plugin.schema.validate: validated",
  );

  return { valid, errors };
};
