// delete_approval_rule — take one auto-approval rule out of the workspace's
// rule set (MC spec §6.9 part 2; ADR-070).
//
// The Tools page offers "switch off instead" beside it, because a rule that is
// off keeps its id and so keeps the 30-day counters and every receipt that
// cites it readable. Deleting is for a rule that was a mistake.
import { z } from "zod";
import { approvalRuleIdSchema } from "../approval-rules/schemas";
import { registerCapability } from "../registry";
import { approvalRuleListItem } from "./approval_rule.list";

export const approvalRuleDelete = registerCapability({
  name: "delete_approval_rule",
  domain: "approval_rule",
  description: "Remove one auto-approval rule from the workspace's rule set",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({ ruleId: approvalRuleIdSchema }).strict(),
  output: z
    .object({
      items: z.array(approvalRuleListItem).max(256),
      windowDays: z.number().int().positive(),
    })
    .strict(),
});

export type ApprovalRuleDeleteInput = z.output<typeof approvalRuleDelete.input>;
export type ApprovalRuleDeleteOutput = z.output<
  typeof approvalRuleDelete.output
>;
