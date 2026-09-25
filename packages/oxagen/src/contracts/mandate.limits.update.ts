import { z } from "zod";
import { registerCapability } from "../registry";
import {
  mandateApprovalSchema,
  mandateIdSchema,
  mandateLimitChangesSchema,
  mandateLimitsSchema,
  mandateSchema,
  mandateTargetsSchema,
} from "../mandates/schemas";

// update_mandate_limits — Change limits on an active mandate: the limits,
// the targets, the mandate's own approval rule and the validity end. The
// ledger keeps its rows; the next reservation reads the new perPeriod. A
// limit added for a measure a matched tool does not declare is refused as
// grant_mandate refuses it. Roles: the consequence roles of every tag.
//
// Limits change two ways, and they are mutually exclusive (ADR-102):
// `limits` replaces the whole record, which is how a bound is deleted, and
// `limitChanges` names the measures to change and leaves the rest, merged
// under the handler's row lock so two concurrent edits cannot restore each
// other's old, wider bounds.
/** The fields, exported for the xmcp tool (the input is a ZodEffects, no `.shape`). */
export const mandateLimitsUpdateFields = {
  mandateId: mandateIdSchema,
  /**
   * The limits as a whole record, **replacing** what is stored. This is the
   * only way to delete a measure's bound, and it stays the primitive for a
   * caller that holds the whole record: an API, MCP or CLI caller that sends
   * `limits` gets exactly the semantics it always had (ADR-102).
   */
  limits: mandateLimitsSchema.optional(),
  /**
   * Change these measures, leave the rest. The handler merges this over the
   * stored record **inside the transaction that locks the row**, at two
   * depths: a measure this does not name keeps its bound, and within a named
   * measure a field this does not carry keeps its stored value, `period`
   * included. That is what makes a concurrent change safe — two operators
   * editing different bounds on one mandate each keep the other's change,
   * where a read-merge-replace round trip lets the later write restore the
   * bound the earlier one lowered.
   *
   * It cannot delete a bound, by construction: an absent field means "leave
   * it". Deletion is `limits` replacement, above.
   *
   * **Carry only the fields you changed.** The merge applies every field a
   * change carries, because that is the only reading a change has: it cannot
   * tell an edit from a value echoed back unchanged. A caller that fills a
   * payload from a record it read and submits all of it restores whatever
   * another caller narrowed in between, through this locked path rather than
   * around it (ADR-102, amendment of 2026-09-19).
   */
  limitChanges: mandateLimitChangesSchema.optional(),
  targets: mandateTargetsSchema.optional(),
  approval: mandateApprovalSchema.optional(),
  validTo: z.string().datetime({ offset: true }).optional(),
};

export const mandateLimitsUpdate = registerCapability({
  name: "update_mandate_limits",
  domain: "mandate",
  description:
    "Change an active mandate's limits, targets, approval rule or validity end. Send `limits` to replace the whole limits record, or `limitChanges` to change named measures and leave the rest; never both. Omitted fields are unchanged; the ledger and remaining authority carry forward.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  sensitivity: "high",
  mutates: true,
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
    .object(mandateLimitsUpdateFields)
    .strict()
    // `limits` replaces the record and `limitChanges` merges into it, so a
    // request carrying both states two different intentions for the same
    // field and there is no reading of it that is safe to guess. Which one
    // wins is not a question because both is invalid.
    .refine(
      (i) => i.limits === undefined || i.limitChanges === undefined,
      "send limits or limitChanges, not both",
    )
    .refine(
      (i) =>
        i.limits !== undefined ||
        i.limitChanges !== undefined ||
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
