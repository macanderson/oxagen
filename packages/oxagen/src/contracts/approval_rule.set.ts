// set_approval_rules — write the workspace's auto-approval rules (MC spec
// §6.9 part 2, App. E; ADR-070). Create and edit are the same write: the
// caller sends the whole set and it replaces the stored clause atomically, so
// two rules can never disagree about which one a call matched first. A rule
// sent back exactly as stored keeps its stamp; only new and changed rules are
// re-checked and re-stamped, plus any rule `saving` names. `replaces` makes the
// write conditional on the set the caller read, for a caller editing one rule
// of it.
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
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
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
      // Ids are unique, refused here rather than stored. A set with two rules
      // under one id parses on the way in and then fails the stored document's
      // own uniqueness check on the way out, which takes the workspace's whole
      // rule set — the gate clause with it — dark until somebody repairs the
      // JSON by hand. A refused write is the cheaper failure.
      rules: z
        .array(approvalRuleBodySchema)
        .max(256)
        .superRefine((rules, issues) => {
          const seen = new Set<string>();
          for (const rule of rules) {
            if (seen.has(rule.id)) {
              issues.addIssue({
                code: z.ZodIssueCode.custom,
                message: `duplicate rule id "${rule.id}" — ids are the audit citation and must be unique`,
              });
            }
            seen.add(rule.id);
          }
        }),
      // The rules as the caller read them, when it built `rules` by editing
      // that read. The write is refused as `conflict` / `rule_set_changed`
      // unless the stored rules are still exactly these, so an edit to one
      // rule cannot write back a rule another person deleted or switched off
      // in between. Omit it to replace the set whatever it holds now.
      replaces: z.array(approvalRuleBodySchema).max(256).optional(),
      // The ids of the rules this write saves on purpose. A rule sent back
      // unchanged keeps its stamp, so re-authorising one held back as
      // `consequences_changed` needs a way to say "check and stamp this one
      // anyway": naming it here re-runs its guards and re-stamps it.
      saving: z.array(z.string().min(1).max(128)).max(256).optional(),
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
