import { z } from "zod";
import { registerCapability } from "../registry";
import {
  mandateApprovalSchema,
  mandateIdSchema,
  mandateLimitsSchema,
  mandateSchema,
  mandateTargetsSchema,
} from "../mandates/schemas";

// update_mandate_limits — Change limits on an active mandate: the limits,
// the targets, the mandate's own approval rule and the validity end. The
// ledger keeps its rows; the next reservation reads the new perPeriod. A
// limit added for a measure a matched tool does not declare is refused as
// grant_mandate refuses it. Roles: the consequence roles of every tag.
export const mandateLimitsUpdate = registerCapability({
  name: "update_mandate_limits",
  domain: "mandate",
  description:
    "Change an active mandate's limits, targets, approval rule or validity end. Omitted fields are unchanged; the ledger and remaining authority carry forward.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: {
      Owner: "allow",
      Admin: "allow",
      Billing: "allow",
      Compliance: "allow",
    },
    workspace: {},
  },
  input: z
    .object({
      mandateId: mandateIdSchema,
      limits: mandateLimitsSchema.optional(),
      targets: mandateTargetsSchema.optional(),
      approval: mandateApprovalSchema.optional(),
      validTo: z.string().datetime({ offset: true }).optional(),
    })
    .strict()
    .refine(
      (i) =>
        i.limits !== undefined ||
        i.targets !== undefined ||
        i.approval !== undefined ||
        i.validTo !== undefined,
      "name at least one change",
    ),
  output: mandateSchema,
});

export type MandateLimitsUpdateInput = z.output<
  typeof mandateLimitsUpdate.input
>;
export type MandateLimitsUpdateOutput = z.output<
  typeof mandateLimitsUpdate.output
>;
