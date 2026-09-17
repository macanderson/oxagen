/**
 * `record_finding_fix`: record that the fix a finding names was applied
 * (Mission Control spec §12.8; ADR-062 §2). The five kinds the job detects
 * have their fix in the agent's own code, harness or tool configuration,
 * which Oxagen does not hold; applying records the change against the
 * finding with the request id its audit row carries, and the job cites only
 * runs that start afterwards, so the saving is attributable on Spend.
 *
 * Org Owner or Admin, checked in the handler. On the agent surface the call
 * waits for a person's approval.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { findingDecisionInputSchema, findingSchema } from "./finding.shared";

export const findingFixRecord = registerCapability({
  name: "record_finding_fix",
  domain: "spend",
  description:
    "Record that the fix an open finding names was applied (org Owner or Admin): the finding becomes applied with the request id of this call, and later passes cite only runs that start after it.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "mutation" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  audit: { targetKind: "cost.finding", targetIdField: "findingId" },
  input: findingDecisionInputSchema,
  output: z.object({ finding: findingSchema }).strict(),
});

export type FindingFixRecordOutput = z.output<typeof findingFixRecord.output>;
