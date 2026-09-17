// list_approval_rules — the workspace's auto-approval rules with what each one
// has done in the last 30 days. The read behind Tools › Auto-approvals
// (MC spec §6.9 part 2, ADR-070).
//
// A console read is outside the metering surface (ADR-052 exclusion 2), so the
// contract declares `noBillingGate: true`; `mutates: false` is what lets the
// app's `kernelRead` accept it.
//
// The two counters are computed from `agent.approval_requests` over the window
// rather than kept in a rollup: they count the rows a rule was read against,
// and the rule set holds tens of rules, so the grouped count is the figure
// itself with nothing to fall out of date. What they do and do not count is on
// `skipped30d` below.
import { z } from "zod";
import { approvalRuleSchema } from "../approval-rules/schemas";
import { registerCapability } from "../registry";

export const approvalRuleListItem = approvalRuleSchema
  .extend({
    /** Calls this rule released with no person in the last 30 days. */
    hits30d: z.number().int().nonnegative(),
    /**
     * Calls in the last 30 days that reached a person's queue with this rule
     * recorded beside them — it was read and did not release them.
     *
     * Both figures count approval rows, so both count the calls that produced
     * one. A decision rule's `require_approval` verdict that no auto-approval
     * rule released writes no approval row at all (the gate refuses the call
     * rather than queueing it), so it appears in neither figure; what is
     * counted is every call a mandate parked. ADR-070.
     */
    skipped30d: z.number().int().nonnegative(),
  })
  .strict();

export const approvalRuleList = registerCapability({
  name: "list_approval_rules",
  domain: "approval_rule",
  description:
    "List the workspace's auto-approval rules, with the calls each released and held in the last 30 days",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "governance" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Compliance: "allow" },
    workspace: {},
  },
  input: z.object({}).strict(),
  output: z
    .object({
      items: z.array(approvalRuleListItem).max(256),
      /** The window the two counters are measured over, in days. */
      windowDays: z.number().int().positive(),
    })
    .strict(),
});

export type ApprovalRuleListInput = z.output<typeof approvalRuleList.input>;
export type ApprovalRuleListOutput = z.output<typeof approvalRuleList.output>;
