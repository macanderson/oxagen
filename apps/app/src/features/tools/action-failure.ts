// The sentence a refused Tools write shows. The kernel classified the refusal
// and put the handler's HandlerError reason in `code` (§3.2). Each reason
// import_tools, set_tool_classification and set_kill_switch throw has its own
// sentence; any other code is printed as recorded.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";

type ActionFailure = Exclude<ActionResult<unknown>, { ok: true }>;

export function useActionFailure(): (failure: ActionFailure) => string {
  const t = useTranslations("tools.actions.failure");
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
          case "server_not_found":
            return t("serverNotFound");
          case "tool_version_not_found":
            return t("versionNotFound");
          case "kill_switch_on":
            return t("killSwitchOn");
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
export const UNANSWERED: ActionFailure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};
