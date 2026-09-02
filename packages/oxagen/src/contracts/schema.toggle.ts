import { z } from "zod";
import { registerCapability } from "../registry";

export const schemaToggle = registerCapability({
  name: "toggle_schema",
  domain: "schema",
  description:
    "Enable/disable a schema. Activation auto-publishes the current draft and auto-pins the resulting version — no separate publish/pin step.",
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
    schemaName: z.string().min(1),
    enabled: z.boolean(),
  }),
  output: z.object({
    schemaName: z.string(),
    enabled: z.boolean(),
    publishedVersionId: z.string().nullable(),
    pinnedVersionId: z.string().nullable(),
    isDowngrade: z.boolean(),
    reconcileRecommended: z.boolean(),
  }),
});

export type SchemaToggleInput = z.output<typeof schemaToggle.input>;
export type SchemaToggleOutput = z.output<typeof schemaToggle.output>;
