import { z } from "zod";
import { registerCapability } from "../registry";

export const schemaVersionPin = registerCapability({
  name: "pin_schema_version",
  domain: "schema",
  description:
    "Point the workspace at a published version; returns whether a pin downgrade occurred.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "schema" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    versionId: z.string().min(1),
  }),
  output: z.object({
    pinnedVersionId: z.string(),
    previousVersionId: z.string().nullable(),
    isDowngrade: z.boolean(),
    reconcileRecommended: z.boolean(),
  }),
});

export type SchemaVersionPinInput = z.output<typeof schemaVersionPin.input>;
export type SchemaVersionPinOutput = z.output<typeof schemaVersionPin.output>;
