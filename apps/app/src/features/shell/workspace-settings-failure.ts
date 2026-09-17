// The sentence a refused Workspace settings read or write shows. The kernel
// seam classified the refusal and put the handler's reason in `code` (§3.2);
// every reason `get_main_repository`, `list_installation_repositories`,
// `list_github_installations`, `attach_github_installation` and
// `bind_main_repository` can give has its own sentence, and any other code is
// printed as recorded rather than collapsed into "something went wrong".
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";

export type WorkspaceSettingsFailure = Exclude<
  ActionResult<unknown>,
  { ok: true }
>;

export function useWorkspaceSettingsFailure(): (
  failure: WorkspaceSettingsFailure,
) => string {
  const t = useTranslations("workspaceSettings.failure");
  return (failure) => {
    switch (failure.reason) {
      case "denied":
        return t("denied");
      case "not_found":
      case "conflict":
        switch (failure.code) {
          case "github_not_connected":
            return t("githubNotConnected");
          case "repository_not_installed":
            return t("repositoryNotInstalled");
          case "main_repo_bound":
            return t("mainRepoBound");
          case "github_not_authorized":
            return t("githubNotAuthorized");
          case "installation_unreachable":
            return t("installationUnreachable");
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

/** A call that threw before it answered, as the seam would name it. */
export const UNANSWERED: WorkspaceSettingsFailure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};
