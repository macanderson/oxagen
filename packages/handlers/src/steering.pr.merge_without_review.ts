// merge_pr_without_review (ADR-213): merge a steering PR that nobody approved.
//
// The caller must hold merge_pr_without_review, as the organization's IAM
// data grants it. The kernel's IAM gate cannot answer that, because it allows
// every call below the enterprise tier, so the handler asks the resolver
// itself before anything else runs. A caller who does not hold it is refused
// `merge_without_review_not_held`, and nothing merges.
//
// A holder then runs merge_steering_pr's handler, told that the caller holds
// the bypass. Every other refusal still applies: a check that did not pass,
// a governance mode that does not let the caller merge, an unhealthy
// repository, a head that moved, and a GitLab project that does not reset
// approvals on push. The Oxagen-Approved-By trailer and the ledger line say
// that nobody reviewed the change, and the `steering.published` event
// carries this capability's name. An approval that already stands at the
// head is still recorded as the approval it is.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import type { steeringPrMerge } from "@oxagen/oxagen/contracts/steering.pr.merge";
import { steeringPrMergeWithoutReview } from "@oxagen/oxagen/contracts/steering.pr.merge_without_review";
import {
  createMergeSteeringPrHandler,
  productionMergeSeams,
  type MergeSeams,
} from "./steering.pr.merge";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";

export function createMergePrWithoutReviewHandler(
  deps: SteeringDeps,
  seams: MergeSeams = {},
): CapabilityHandler<typeof steeringPrMerge> {
  const holds = seams.holdsMergeWithoutReview ?? (async () => false);
  const merge = createMergeSteeringPrHandler(
    deps,
    { ...seams, holdsMergeWithoutReview: async () => true },
    steeringPrMergeWithoutReview.name,
  );

  return async (input, ctx) => {
    const userId = ctx.userId ?? null;
    if (!userId) {
      throw new HandlerError({
        code: "forbidden",
        reason: "no_principal",
        message: "Merging a steering PR without review needs a signed-in user",
      });
    }
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    if (!(await holds(scope, userId))) {
      throw new HandlerError({
        code: "forbidden",
        reason: "merge_without_review_not_held",
        message:
          "Merging a steering PR without review needs the permission to merge a steering PR that no one approved. Ask an organization owner to grant it, or merge the PR after a member approves it.",
      });
    }
    return merge(input, ctx);
  };
}

export const mergePrWithoutReviewHandler = createMergePrWithoutReviewHandler(
  steeringDeps(),
  productionMergeSeams,
);
