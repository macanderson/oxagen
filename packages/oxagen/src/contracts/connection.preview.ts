import { z } from "zod";
import { registerCapability } from "../registry";

export const connectionPreview = registerCapability({
  name: "preview_connection",
  domain: "connection",
  description:
    "Preview sample records from a data source connection. Used in the setup wizard to show what data will be ingested.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "high",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    connectionId: z.string().min(1).describe("Public ID or internal UUID of the connection"),
  }),
  output: z.object({
    recordTypes: z.array(
      z.object({
        sourceRecordType: z.string().describe("Raw record type from the connector"),
        displayName: z.string(),
        description: z.string().optional(),
        sampleCount: z.number(),
        sampleFields: z
          .array(z.string())
          .describe("Key field names seen in sample records"),
        sampleRecords: z
          .array(z.record(z.unknown()))
          .max(3)
          .describe("Up to 3 sample records for display"),
      }),
    ),
  }),
});

export type ConnectionPreviewInput = z.output<typeof connectionPreview.input>;
export type ConnectionPreviewOutput = z.output<typeof connectionPreview.output>;
