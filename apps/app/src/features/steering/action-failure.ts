// The sentence a refused steering PR write shows. The kernel classified the
// refusal and put the handler's HandlerError reason in `code` (§3.2). Each
// reason open_steering_pr, merge_steering_pr, dismiss_proposal,
// revert_steering_pr, approve_steering_pr, drop_memory_record and the merge
// queue throw has its own sentence. A write the platform has not registered
// yet answers `tool_not_registered` and says so. Any other code is printed as
// recorded.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";

type ActionFailure = Exclude<ActionResult<unknown>, { ok: true }>;

export function useActionFailure(): (failure: ActionFailure) => string {
  const t = useTranslations("steering.actions.failure");
  return (failure) => {
    switch (failure.reason) {
      case "denied":
      case "not_found":
      case "conflict":
        switch (failure.code) {
          case "org_role_required":
            return t("orgRoleRequired");
          case "no_principal":
            return t("noPrincipal");
          case "separation_of_duties":
            return t("separationOfDuties");
          case "proposal_not_found":
            return t("proposalNotFound");
          case "lineage_pr_open":
            return t("lineagePrOpen");
          case "governance_unreadable":
            return t("governanceUnreadable");
          case "workspace_repository_missing":
            return t("repositoryMissing");
          case "checks_not_passed":
            return t("checksNotPassed");
          case "approval_required":
            return t("approvalRequired");
          case "approvals_not_head_bound":
            return t("approvalsNotHeadBound");
          case "head_moved":
            return t("headMoved");
          case "base_moved":
            return t("baseMoved");
          case "github_refused":
            return t("githubRefused");
          case "gitlab_refused":
            return t("gitlabRefused");
          case "gitlab_credential_rejected":
            return t("gitlabCredentialRejected");
          case "repository_host_changed":
            return t("repositoryHostChanged");
          case "merge_time_unknown":
            return t("mergeTimeUnknown");
          case "merged_outside_oxagen":
            return t("mergedOutsideOxagen");
          case "already_merged":
            return t("proposalMoved");
          case "repository_unhealthy":
            return t("repositoryUnhealthy");
          case "too_many_files":
            return t("tooManyFiles");
          case "version_mismatch":
            return t("versionMismatch");
          case "record_file_missing":
            return t("recordFileMissing");
          case "production_branch_missing":
            return t("productionBranchMissing");
          case "production_branch_moving":
            return t("productionBranchMoving");
          case "checks_failed":
            return t("checksFailed");
          case "not_merged":
            return t("notMerged");
          case "governance_proposal":
            return t("governanceProposal");
          case "pr_not_recorded":
            return t("prNotRecorded");
          case "repository_changed":
            return t("repositoryChanged");
          case "merge_commit_unknown":
            return t("mergeCommitUnknown");
          // approve_steering_pr and drop_memory_record (#4518).
          case "author_cannot_approve":
            return t("authorCannotApprove");
          case "pr_closed":
            return t("prClosed");
          case "memory_pr_not_found":
            return t("memoryPrNotFound");
          case "memory_pr_settled":
            return t("memoryPrSettled");
          case "record_not_in_pr":
            return t("recordNotInPr");
          case "record_not_proposed":
            return t("recordNotProposed");
          case "memory_pr_elsewhere":
            return t("memoryPrElsewhere");
          case "branch_missing":
            return t("branchMissing");
          case "last_record":
            return t("lastRecord");
          case "nothing_to_revert":
            return t("nothingToRevert");
          case "revert_branch_exists":
            return t("revertBranchExists");
          // restore_managed_block (#4518).
          case "block_intact":
            return t("blockIntact");
          case "no_managed_block":
            return t("noManagedBlock");
          case "no_managed_blocks":
            return t("noManagedBlocks");
          case "pr_not_open":
            return t("prNotOpen");
          default:
            // The status writes refuse with proposal_<status> when another
            // call moved the proposal first.
            return failure.code.startsWith("proposal_")
              ? t("proposalMoved")
              : t("refused", { code: failure.code });
        }
      case "invalid":
        return t("invalid");
      case "pending_approval":
        return t("pendingApproval", {
          accessRequestId: failure.accessRequestId,
        });
      case "exhausted":
      case "unavailable":
        // The kernel answers a capability no handler registered with
        // `tool_not_registered`, before it reads the input (#4518).
        return failure.code === "tool_not_registered"
          ? t("toolNotRegistered")
          : t("unavailable", { code: failure.code });
    }
  };
}

/** A write that threw before it answered, as the seam would name it. */
export const UNANSWERED: ActionFailure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};
