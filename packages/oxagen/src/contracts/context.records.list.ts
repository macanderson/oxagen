// list_records — the workspace's published steering records: what is in force
// on the production branch of the main repo (or a linked repo), with the
// classification the Records tab renders (ADR-061; MC spec §10.2, App. E).
//
// A console read is outside the metering surface (ADR-052 exclusion 2), so
// the contract declares `noBillingGate: true`; `mutates: false` is what lets
// the app's `kernelRead` accept it.
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  publishedRecordSchema,
  publishedSharingScopeSchema,
  recordKindSchema,
} from "./context.steering.shared";

export const contextRecordsList = registerCapability({
  name: "list_records",
  domain: "context",
  description:
    "List the workspace's published steering records with kind, force, constraint effect, scope, lineage, commit and path, filtered by kind, scope, status or lineage",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z
    .object({
      kind: recordKindSchema.optional(),
      sharingScope: publishedSharingScopeSchema.optional(),
      status: z.enum(["active", "retired", "superseded"]).optional(),
      lineageId: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().nonnegative().default(0),
    })
    .strict(),
  output: z
    .object({
      records: z.array(publishedRecordSchema),
      /** The count ignoring limit/offset. */
      total: z.number().int().nonnegative(),
    })
    .strict(),
});

export type ContextRecordsListInput = z.output<typeof contextRecordsList.input>;
export type ContextRecordsListOutput = z.output<
  typeof contextRecordsList.output
>;
