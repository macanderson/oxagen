import type { CapabilityHandler } from "@oxagen/oxagen";
import { pluginSchemaGet } from "@oxagen/oxagen/contracts/plugin.schema.get";
import { logger } from "./logger";

export const pluginSchemaGetHandler: CapabilityHandler<typeof pluginSchemaGet> = async (input, ctx) => {
  // TODO: Fetch plugin schema YAML from the plugin catalog (registry or bundled catalog),
  // parse and return the typed ConnectorPluginSchema
  logger.info(
    { pluginId: input.pluginId },
    "plugin.schema.get: fetched (stub)",
  );

  return {
    apiVersion: "oxagen.ai/v1alpha1" as const,
    kind: "ConnectorPlugin" as const,
    metadata: {
      id: input.pluginId,
      displayName: input.pluginId,
      description: undefined,
      icon: undefined,
      category: undefined,
      version: "1.0.0",
      schemaVersion: "1",
      publisher: {
        name: "Oxagen",
        verified: true,
      },
    },
    auth: undefined,
    config: undefined,
    recordTypes: undefined,
    filters: undefined,
    inference: undefined,
    sync: undefined,
    defaultFieldMappings: undefined,
  };
};
