// The sentence a refused onboarding write shows. The kernel classified the
// refusal and put the handler's HandlerError reason in `code` (§3.2). Each
// reason the bound handlers throw — register_agent, create_enrollment_token,
// advance_onboarding and bind_main_repository — has its own sentence; any
// other code is printed as recorded, with no cause attached to it.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";

export type OnboardingFailure = Exclude<ActionResult<unknown>, { ok: true }>;

export function useOnboardingFailure(): (
  failure: OnboardingFailure,
) => string {
  const t = useTranslations("onboarding.register.failure");
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
          case "agent_not_found":
            return t("agentNotFound");
          case "slug_taken":
            return t("slugTaken");
          case "gate_not_found":
            return t("gateNotFound");
          case "already_unlocked":
            return t("alreadyUnlocked");
          case "first_frame_required":
            return t("firstFrameRequired");
          case "github_not_connected":
            return t("githubNotConnected");
          case "repository_not_installed":
            return t("repositoryNotInstalled");
          case "main_repo_bound":
            return t("mainRepoBound");
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
export const UNANSWERED: OnboardingFailure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};
