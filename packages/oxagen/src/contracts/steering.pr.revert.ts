// revert_steering_pr: open a steering PR that undoes a merged one
// (steering-repo-spec, Steering PR flow: Revert; #4449).
//
// The input names the merged proposal. The handler reads the commit its merge
// landed on the production branch and that commit's first parent, then opens
// a PR that puts every path the merge changed back to what the parent held.
// The ledger under steering/promotions/ is left alone, because the ledger
// only grows. In a steering repo Oxagen runs the steering checks on the new
// branch and reports the required "Oxagen steering" check on it.
//
// A revert is a merge-class action, so it takes merge_steering_pr's roles and
// its governance-mode rule: solo lets any workspace member revert, team asks
// for an org Owner or Admin or a workspace Owner, and regulated asks for an
// org Owner or Admin. It opens a PR and merges nothing, so the approval that
// merge_pr_without_review skips does not arise here. The revert PR's own merge
// faces the approval rules.
//
// Unlike merge_steering_pr, it acts for an API key's creator, so the MCP and
// CLI surfaces work. Opening a PR records no approval, so a key cannot stand
// in for a reviewer through it.
//
// A governance proposal is refused: the governance mode changes only through
// set_governance_mode (ADR-232).
import { z } from "zod";
import { registerCapability } from "../registry";

export const steeringPrRevert = registerCapability({
  name: "revert_steering_pr",
  domain: "context",
  description:
    "Open a steering PR that undoes a merged one: each path the merge changed goes back to what the production branch held before it, and the ledger is left as it is. In a steering repo Oxagen runs the steering checks on the revert and reports the required Oxagen steering check. Refused unless the proposal is merged, and unless the governance mode lets the caller merge. A governance change is refused: set the mode again instead",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      /** The merged proposal whose steering PR the revert undoes. */
      proposalId: z.string().regex(/^prp_[0-9A-Za-z]+$/),
    })
    .strict(),
  output: z
    .object({
      /** The merged proposal the revert undoes. */
      proposalId: z.string(),
      /** The merged steering PR: its number and its merge commit. */
      reverted: z
        .object({
          number: z.number().int().positive(),
          mergedCommit: z.string(),
        })
        .strict(),
      /** The revert steering PR Oxagen opened. */
      pullRequest: z
        .object({
          number: z.number().int().positive(),
          url: z.string(),
          branch: z.string(),
          /** The revert branch's head, or null when the host did not say. */
          headSha: z.string().nullable(),
        })
        .strict(),
      /**
       * The Oxagen steering check reported on the revert's head. Null in a
       * legacy repository, which has no required check, and null when the
       * host refused the report.
       */
      check: z.enum(["success", "failure"]).nullable(),
    })
    .strict(),
});

export type SteeringPrRevertInput = z.output<typeof steeringPrRevert.input>;
export type SteeringPrRevertOutput = z.output<typeof steeringPrRevert.output>;
