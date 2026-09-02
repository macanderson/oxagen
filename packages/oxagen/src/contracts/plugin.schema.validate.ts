import { z } from "zod";
import { registerCapability } from "../registry";

// Single field validation error
const fieldErrorSchema = z.object({
  field: z
    .string()
    .describe("Dot-path to the invalid field (e.g. 'config.organizations')"),
  message: z.string().describe("Human-readable validation error message"),
  code: z
    .enum([
      "required",
      "min",
      "max",
      "minItems",
      "maxItems",
      "pattern",
      "itemPattern",
      "oneOf",
      "type",
      "unknown",
    ])
    .describe("Machine-readable validation rule that failed"),
});

export const pluginSchemaValidate = registerCapability({
  name: "validate_plugin_schema",
  domain: "plugin",
  description:
    "Validate a connector plugin config object against its schema before install or configure. Returns field-level errors for form display.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "low", category: "plugin" },
  layers: ["schema", "api", "mcp", "unit", "docs"],
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
    authSchemeId: z
      .string()
      .optional()
      .describe(
        "Auth scheme being used (e.g. 'oauth2', 'pat'). Required when plugin has multiple auth schemes.",
      ),
    config: z
      .record(z.unknown())
      .describe(
        "Config values keyed by field key. Nested sections use dot-path or nested objects.",
      ),
  }),
  output: z.object({
    valid: z.boolean().describe("True when all fields pass validation"),
    errors: z
      .array(fieldErrorSchema)
      .describe("Field-level validation errors. Empty when valid is true."),
  }),
});
