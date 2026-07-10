import { z } from "zod";
import { registerCapability } from "../registry";
import {
  resellerAttributionRuleSchema,
  resellerMatchKindSchema,
} from "./reseller-shared";

/**
 * save_reseller_attribution_rule — upsert a rule mapping a slice of observed
 * usage (by workspace, acting principal, or capability) to a customer account.
 * This is the join between the metering graph and the customer being billed —
 * the accountability edge that makes per-customer revenue possible.
 *
 * Upsert: omit `id` to create, pass a rule public id to update in place.
 */
export const resellerAttributionRuleSave = registerCapability({
  name: "save_reseller_attribution_rule",
  domain: "billing",
  description:
    "Create or update an attribution rule mapping observed usage (by workspace, principal, or capability) to a reseller customer, with a priority for tie-breaking.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "low", category: "billing" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Billing: "allow" }, workspace: {} },
  input: z.object({
    /** public id of a rule to update, or omit to create. */
    id: z.string().min(1).optional(),
    matchKind: resellerMatchKindSchema,
    /** Raw identifier to match (workspace/principal id, or capability name). */
    matchValue: z.string().min(1).max(300),
    /** Human label captured at creation, shown instead of the raw match value. */
    matchLabel: z.string().min(1).max(300),
    /** public id of the customer this slice bills to. */
    customerId: z.string().min(1),
    /** Lower runs first; first matching rule wins a usage slice. */
    priority: z.number().int().min(0).max(100_000).default(100),
  }),
  output: z.object({ rule: resellerAttributionRuleSchema }),
});

export type ResellerAttributionRuleSaveInput = z.output<
  typeof resellerAttributionRuleSave.input
>;
export type ResellerAttributionRuleSaveOutput = z.output<
  typeof resellerAttributionRuleSave.output
>;
