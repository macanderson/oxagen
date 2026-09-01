import { z } from "zod";
import { registerCapability } from "../registry";

export const contextRecordList = registerCapability({
  name: "list_context_records",
  domain: "context",
  description:
    "List the steering context records registered in the active workspace, each with its lifecycle status and pinned active version",
  mode: "sync",
  surfaces: ["api", "agent", "mcp"],
  layers: ["schema", "api", "docs", "mcp", "unit"],
  scoped: true,
  noBillingGate: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
  },
  input: z
    .object({
      status: z
        .enum(["active", "retired", "superseded"])
        .optional()
        .describe("Only return records in this lifecycle status"),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .default(50)
        .describe("Maximum number of records to return (default 50, max 200)"),
      offset: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Pagination offset (number of records to skip)"),
    })
    .strict(),
  output: z
    .object({
      records: z.array(
        z
          .object({
            id: z.string().describe("Public record ID (ctr_…)"),
            recordId: z.string().describe("The record's stable id (slug)"),
            title: z.string(),
            status: z.string(),
            version: z
              .number()
              .int()
              .nullable()
              .describe("Active version number; null when none is pinned"),
            checksum: z.string().nullable(),
            updatedAt: z.string().datetime(),
          })
          .strict(),
      ),
      total: z
        .number()
        .int()
        .describe("Total records in the workspace matching the filter"),
    })
    .strict(),
});

export type ContextRecordListInput = z.output<typeof contextRecordList.input>;
export type ContextRecordListOutput = z.output<typeof contextRecordList.output>;
