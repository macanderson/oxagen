// The sentence a refused revision shows (#3395). `revise_context_record`
// refuses on its own two reasons and then hands the proposal to
// `open_context_pr`, so every reason that call throws reaches here too.
// Anything else is printed with its code attached rather than flattened into
// "something went wrong": the code is what a reader pastes into an incident.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";

type ReviseFailure = Exclude<ActionResult<unknown>, { ok: true }>;

export function useReviseFailure(): (failure: ReviseFailure) => string {
  const t = useTranslations("record.failure");
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
          case "record_not_found":
            return t("recordNotFound");
          case "record_unclassified":
            return t("recordUnclassified");
          case "constraint_effect_unknown":
            return t("constraintEffectUnknown");
          case "lineage_pr_open":
            return t("lineagePrOpen");
          case "workspace_repository_missing":
            return t("repositoryMissing");
          case "governance_unreadable":
            return t("governanceUnreadable");
          case "github_refused":
            return t("githubRefused");
          default:
            return t("refused", { code: failure.code });
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
export const UNANSWERED: ReviseFailure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};
