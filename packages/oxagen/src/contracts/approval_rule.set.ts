// set_approval_rules — write the workspace's auto-approval rules (MC spec
// §6.9 part 2, App. E; ADR-068). Create and edit are the same write: the
// caller sends the whole set and it replaces the stored clause atomically, so
// two rules can never disagree about which one a call matched first.
//
// `agent.requiresApproval: true`: an agent that asks to widen the conditions
// under which its own calls skip a person waits for one. `noBillingGate: true`:
// writing governance is settings, not a governed action (ADR-052 exclusion 2).
//
// The handler refuses a rule whose tool patterns match no declared tool, whose
// measures the matched tools do not declare, or whose consequences the caller
// does not hold the org role for — the spec's rule that a rule cannot be saved
// that would widen an agent past its operator's grants.
import { z } from "zod";
import { approvalRuleBodySchema } from "../approval-rules/schemas";
import { registerCapability } from "../registry";
import { approvalRuleListItem } from "./approval_rule.list";

export const approvalRuleSet = registerCapability({
  name: "set_approval_rules",
  domain: "approval_rule",
  description:
    "Replace the workspace's auto-approval rules — the conditions under which a call a policy sent to a person may skip them",
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
    .object({
      rules: z.array(approvalRuleBodySchema).max(256),
    })
    .strict(),
  output: z
    .object({
      items: z.array(approvalRuleListItem).max(256),
      windowDays: z.number().int().positive(),
    })
    .strict(),
});

export type ApprovalRuleSetInput = z.output<typeof approvalRuleSet.input>;
export type ApprovalRuleSetOutput = z.output<typeof approvalRuleSet.output>;
