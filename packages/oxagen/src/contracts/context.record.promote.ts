import { z } from "zod";
import { registerCapability } from "../registry";

export const contextRecordPromote = registerCapability({
  name: "promote_context_record",
  domain: "context",
  description:
    "Append a lifecycle action (promote / retire / supersede) to a context record's hash-chained promotions ledger and apply it to the record — mirrors Stella's promotions.jsonl: chain_digest = sha256(prev_digest + canonical row)",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "docs", "unit"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z
    .object({
      record_id: z
        .string()
        .min(1)
        .describe("Public record ID (ctr_…) or its stable id (slug)"),
      action: z
        .enum(["promote", "retire", "supersede"])
        .describe(
          "promote pins a version active; retire ends the record's life; supersede marks it replaced",
        ),
      version_id: z
        .string()
        .optional()
        .describe(
          "Public version ID (crv_…) the action names — required for promote",
        ),
      policy_version: z
        .string()
        .min(1)
        .describe("The governance policy version this action was taken under"),
    })
    .strict(),
  output: z
    .object({
      recordId: z.string().describe("Public record ID (ctr_…)"),
      action: z.enum(["promote", "retire", "supersede"]),
      seq: z
        .number()
        .int()
        .positive()
        .describe("This entry's position in the record's chain"),
      chainDigest: z
        .string()
        .describe("SHA-256 hex chain digest of this ledger entry"),
      status: z
        .string()
        .describe("The record's lifecycle status after the action"),
    })
    .strict(),
});

export type ContextRecordPromoteInput = z.output<
  typeof contextRecordPromote.input
>;
export type ContextRecordPromoteOutput = z.output<
  typeof contextRecordPromote.output
>;
