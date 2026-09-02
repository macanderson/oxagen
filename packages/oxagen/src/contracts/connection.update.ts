import { z } from "zod";
import { registerCapability } from "../registry";

// Rename a source connection and/or adjust its delivery configuration (sync
// schedule, scope). Partial — omit a field to leave it unchanged. Pause/resume
// is handled separately by connection.pause.
export const connectionUpdate = registerCapability({
  name: "update_connection",
  domain: "connection",
  description:
    "Update a data source connection: rename it (displayName) and/or adjust its delivery configuration (sync schedule, scope). Partial update — omit a field to keep it. Pausing/resuming is connection.pause.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "connection" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    connectionId: z
      .string()
      .min(1)
      .describe("Public ID or internal UUID of the connection"),
    displayName: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("New display name"),
    deliveryConfig: z
      .record(z.unknown())
      .nullable()
      .optional()
      .describe(
        "Replacement delivery configuration (sync schedule/scope); null clears it",
      ),
  }),
  output: z.object({
    connectionId: z.string(),
    displayName: z.string(),
    status: z.string(),
    deliveryConfig: z.record(z.unknown()).nullable(),
  }),
});

export type ConnectionUpdateInput = z.output<typeof connectionUpdate.input>;
export type ConnectionUpdateOutput = z.output<typeof connectionUpdate.output>;
