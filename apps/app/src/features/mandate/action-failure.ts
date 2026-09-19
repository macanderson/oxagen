// The sentence a refused mandate write shows. The kernel classified the refusal
// and put the handler's `HandlerError` reason in `code` (ARCHITECTURE.md §3.2),
// so each reason the two bound handlers throw has its own sentence and any
// other code is printed as recorded, with no cause invented for it.
//
// Every sentence says what happened to the record, because a person reading a
// refusal on a page of financial authority needs to know whether the mandate
// moved. Both handlers do their role check and their status check before they
// write, so in each of these cases nothing changed, and each sentence says so.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";

export type ActionFailure = Exclude<ActionResult<unknown>, { ok: true }>;

export function useActionFailure(): (failure: ActionFailure) => string {
  const t = useTranslations("mandate.actions.failure");
  return (failure) => {
    switch (failure.reason) {
      case "denied":
      case "not_found":
      case "conflict":
        switch (failure.code) {
          case "org_role_required":
            return t("orgRoleRequired");
          case "no_role_covers_all_tags":
            return t("noRoleCoversAllTags");
          case "mandate_not_found":
            return t("mandateNotFound");
          case "mandate_ended":
            return t("mandateEnded");
          case "validity_inverted":
            return t("validityInverted");
          case "no_tool_matches":
            return t("noToolMatches");
          case "measure_not_declared":
            return t("measureNotDeclared");
          case "measure_unit_mismatch":
            return t("measureUnitMismatch");
          case "no_principal":
            return t("noPrincipal");
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

/** A write that threw before it answered, as the seam would have named it. */
export const UNANSWERED: ActionFailure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};
