// The sentence a refused run command shows. The kernel classified the refusal
// and put the handler's reason in `code` (§3.2); each reason `dispatch_command`
// throws has its own sentence, and any other code is printed as recorded with
// no cause attached to it.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";

export type CommandFailure = Exclude<ActionResult<unknown>, { ok: true }>;

export function useActionFailure(): (failure: CommandFailure) => string {
  const t = useTranslations("run.commands.failure");
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
          case "run_not_found":
            return t("runNotFound");
          case "no_connection_point":
            return t("noConnectionPoint");
          case "run_sealed":
            return t("runSealed");
          case "observe_tier":
            return t("observeTier");
          case "run_not_sealed":
            return t("runNotSealed");
          case "digest_only":
            return t("digestOnly");
          default:
            return t("refused", { code: failure.code });
        }
      case "invalid":
        return failure.code === "steer_text" ? t("steerText") : t("invalid");
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

/** A command that threw before it answered, as the seam would name it. */
export const UNANSWERED: CommandFailure = {
  ok: false,
  reason: "unavailable",
  code: "command_failed",
};
