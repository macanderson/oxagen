// The sentence a refused Context PR write shows. The kernel classified the
// refusal and put the handler's HandlerError reason in `code` (§3.2). Each
// reason open_context_pr, merge_context_pr and dismiss_proposal throw has its
// own sentence; any other code is printed as recorded.
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
          case "already_merged":
            return t("proposalMoved");
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
        return t("unavailable", { code: failure.code });
    }
  };
}

/** A write that threw before it answered, as the seam would name it. */
export const UNANSWERED: ActionFailure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};
