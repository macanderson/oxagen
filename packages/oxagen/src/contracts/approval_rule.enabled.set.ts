// set_approval_rule_enabled — switch one auto-approval rule on or off
// (MC spec §6.9 part 2; ADR-068).
//
// The one write on this page that is not a rewrite of the whole set: an
// operator stopping a rule mid-incident should not have to send every other
// rule back with it.
import { z } from "zod";
import { approvalRuleIdSchema } from "../approval-rules/schemas";
import { registerCapability } from "../registry";
import { approvalRuleListItem } from "./approval_rule.list";

export const approvalRuleEnabledSet = registerCapability({
  name: "set_approval_rule_enabled",
  domain: "approval_rule",
  description: "Switch one auto-approval rule on or off",
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
  input: z
    .object({ ruleId: approvalRuleIdSchema, enabled: z.boolean() })
    .strict(),
  output: z
    .object({
      items: z.array(approvalRuleListItem).max(256),
      windowDays: z.number().int().positive(),
    })
    .strict(),
});

export type ApprovalRuleEnabledSetInput = z.output<
  typeof approvalRuleEnabledSet.input
>;
export type ApprovalRuleEnabledSetOutput = z.output<
  typeof approvalRuleEnabledSet.output
>;
