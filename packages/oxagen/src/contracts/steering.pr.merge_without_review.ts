// merge_pr_without_review: merge a steering PR that nobody approved (ADR-213).
// It is merge_steering_pr with one gate moved. The caller must hold this
// capability, and then the approval merge_steering_pr asks for outside solo
// mode is not needed. Everything else still holds: every check passed, the
// governance mode lets the caller merge, the repository is healthy, and the
// head is the commit the checks ran on. The trailer and the ledger record
// that nobody reviewed the change. The input and the output are
// merge_steering_pr's, so a caller reads one answer from both.
import { registerCapability } from "../registry";
import { steeringPrMerge } from "./steering.pr.merge";

export const steeringPrMergeWithoutReview = registerCapability({
  name: "merge_pr_without_review",
  domain: "context",
  description:
    "Merge a proposal's steering PR without an approval and publish its record: refused unless the caller holds merge_pr_without_review, and refused on every other ground merge_steering_pr refuses; the trailer and the ledger record that nobody reviewed it",
  mode: "sync",
  surfaces: ["api", "agent"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow" },
    workspace: { Owner: "allow" },
  },
  input: steeringPrMerge.input,
  output: steeringPrMerge.output,
});
