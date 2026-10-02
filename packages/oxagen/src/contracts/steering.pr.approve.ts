// approve_steering_pr: approve a proposal's steering PR at its head (#4518,
// ADR-267).
//
// Under the team and regulated governance modes, merge_steering_pr lands a
// steering PR only after a workspace member other than the author approves
// it at the head that merges. The Oxagen GitHub App opens every steering PR,
// and GitHub refuses an app's approving review of a pull request it opened.
// So the approval is stored in Oxagen, at the PR's head, and the merge counts
// it beside the approvals on the host under the same rule.
//
// The approver is a signed-in person. An API key resolves to the person who
// made it, so a key held by an agent could approve a change it proposed. The
// contract is on the api surface only, which the web app reaches with the
// person's session, and the handler refuses a call that carries no user.
// It is off the agent surface for the same reason resolve_approval is
// (ADR-175): a review is a person's decision.
import { z } from "zod";
import { registerCapability } from "../registry";

export const steeringPrApprove = registerCapability({
  name: "approve_steering_pr",
  domain: "context",
  description:
    "Approve a proposal's steering PR at its current head. Under the team and regulated governance modes the merge counts this approval beside the approvals on the host. Refused to the PR's author, on a pull request that is not open, and when the head moved since the checks ran. Answers how many people approved the head in Oxagen.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      proposalId: z.string().regex(/^prp_[0-9A-Za-z]+$/),
    })
    .strict(),
  output: z
    .object({
      proposalId: z.string(),
      /** The PR head the approval is for. A push to the branch makes it stale. */
      headSha: z.string(),
      /** How many people approved this head in Oxagen, this approval included. */
      approvals: z.number().int().positive(),
    })
    .strict(),
});

export type SteeringPrApproveInput = z.output<typeof steeringPrApprove.input>;
export type SteeringPrApproveOutput = z.output<typeof steeringPrApprove.output>;
