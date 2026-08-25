import { z } from "zod";
import { registerCapability } from "../registry";

// Shared field validation schema (used in both schema.get and schema.validate)
const fieldValidationSchema = z.object({
  required: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  minItems: z.number().int().optional(),
  maxItems: z.number().int().optional(),
  pattern: z.string().optional(),
  itemPattern: z.string().optional(),
  oneOf: z.array(z.string()).optional(),
});

// Widget type enum covering all supported form widgets
const widgetTypeEnum = z.enum([
  "text",
  "email",
  "url",
  "secret",
  "number",
  "textarea",
  // Multi-line monospace input for SQL / JSON / payload config. Declared by the
  // custom-sql, custom-webhook, and google-bigquery connector schemas; omitting
  // it here made get_plugin_schema fail OUTPUT validation (invalid_output → 500)
  // for exactly those connectors.
  "code",
  "select",
  "multi-select",
  "tag-input",
  "checkbox",
  "slider",
  "key-value",
  "secret-file",
]);

// Single config/auth field definition
const schemaFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  widget: widgetTypeEnum,
  description: z.string().optional(),
  placeholder: z.string().optional(),
  defaultValue: z.unknown().optional(),
  options: z
    .array(z.object({ value: z.string(), label: z.string() }))
    .optional(),
  dependsOn: z.object({ field: z.string(), value: z.unknown() }).optional(),
  validation: fieldValidationSchema.optional(),
  // What the field's text MEANS, where the widget alone cannot say.
  //
  // A "code" widget holds SQL for google-bigquery and JSON for custom-webhook
  // and custom-sql, so the widget cannot decide whether to parse. Without this
  // the JSON ones were stored as raw text, which their own connection schemas
  // (`recordTypes: z.array(...)`, `queries: z.array(...)`) can never accept —
  // so neither connector could be configured through the wizard at all, and
  // connection.preview died inside the connector on
  // `config.recordTypes.map is not a function`.
  //
  // This object strips unknown keys, so a field the contract does not declare
  // never reaches the client — the same way omitting "code" from the widget
  // enum above once turned get_plugin_schema into a 500.
  format: z.enum(["json"]).optional(),
});

// Auth scheme definition
const authSchemeSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "oauth2_authorization_code",
    "oauth2_client_credentials",
    "api_key",
    "basic",
    "none",
  ]),
  label: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  fields: z.array(schemaFieldSchema).optional(),
});

// Record type item
const recordTypeItemSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  defaultEnabled: z.boolean(),
});

// Full connector plugin schema output
const connectorPluginSchemaOutput = z.object({
  apiVersion: z.literal("oxagen.ai/v1alpha1"),
  kind: z.literal("ConnectorPlugin"),
  metadata: z.object({
    id: z.string(),
    displayName: z.string(),
    description: z.string().optional(),
    icon: z.string().optional(),
    category: z.string().optional(),
    version: z.string(),
    schemaVersion: z.string(),
    publisher: z.object({
      name: z.string(),
      verified: z.boolean(),
    }),
  }),
  auth: z
    .object({
      schemes: z.array(authSchemeSchema),
    })
    .optional(),
  config: z
    .object({
      fields: z.array(schemaFieldSchema),
    })
    .optional(),
  recordTypes: z
    .object({
      selectionMode: z.enum(["single", "multi"]),
      defaultAll: z.boolean().optional(),
      items: z.array(recordTypeItemSchema),
    })
    .optional(),
  filters: z
    .object({
      pathFilters: z
        .object({
          enabled: z.boolean(),
          defaultIgnore: z.array(z.string()).optional(),
          appliesTo: z.array(z.string()).optional(),
        })
        .optional(),
      labelFilters: z
        .object({
          enabled: z.boolean(),
          appliesTo: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
  sync: z
    .object({
      delivery: z.enum(["webhook", "polling", "manual"]),
      pollingSupported: z.boolean().optional(),
      polling: z
        .object({
          defaultIntervalSeconds: z.number().int().positive(),
          minIntervalSeconds: z.number().int().positive(),
        })
        .optional(),
    })
    .optional(),
  defaultFieldMappings: z.record(z.record(z.string())).optional(),
});

export type ConnectorPluginSchema = typeof connectorPluginSchemaOutput._type;
export { fieldValidationSchema, widgetTypeEnum, schemaFieldSchema };

export const pluginSchemaGet = registerCapability({
  name: "get_plugin_schema",
  domain: "plugin",
  description:
    "Fetch the typed config schema for a connector plugin, used to drive dynamic form rendering during install and configure flows.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "low", category: "plugin" },
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    pluginId: z
      .string()
      .describe("Connector plugin identifier (e.g. 'github', 'google-drive')"),
  }),
  output: connectorPluginSchemaOutput,
});
