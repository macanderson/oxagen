import type { CapabilityHandler } from "@oxagen/oxagen";
import { pluginSchemaValidate } from "@oxagen/oxagen/contracts/plugin.schema.validate";
import { logger } from "./logger";

export const pluginSchemaValidateHandler: CapabilityHandler<typeof pluginSchemaValidate> = async (input, ctx) => {
  // TODO: Fetch plugin schema, extract the relevant auth scheme fields and config fields,
  // then validate input.config against the field definitions (required, patterns, oneOf, etc.)
  logger.info(
    { pluginId: input.pluginId, authSchemeId: input.authSchemeId },
    "plugin.schema.validate: validated (stub)",
  );

  return {
    valid: true,
    errors: [],
  };
};
