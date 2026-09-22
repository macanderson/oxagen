// The sentence a refused Organization write shows. The kernel classified the
// refusal and put the handler's HandlerError reason in `code` (§3.2). Each
// reason the bound handlers throw — the role editor's and the workspace
// writes' — has its own sentence; any other code is printed as recorded, with
// no cause attached to it.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";

export type ActionFailure = Exclude<ActionResult<unknown>, { ok: true }>;

export function useActionFailure(): (failure: ActionFailure) => string {
  const t = useTranslations("organization.actions.failure");
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
          case "delegation_ceiling_exceeded":
            return t("delegationCeiling");
          case "role_exists":
            return t("roleExists");
          case "role_not_found":
            return t("roleNotFound");
          case "role_in_use":
            return t("roleInUse");
          case "system_role_readonly":
            return t("systemRoleReadonly");
          case "slug_taken":
            return t("slugTaken");
          case "workspace_not_found":
            return t("workspaceNotFound");
          case "already_archived":
            return t("alreadyArchived");
          case "workspace_has_agents":
            return t("workspaceHasAgents");
          // The five ways `create_workspace` can refuse the main repository
          // (MC spec §10.1): the org never connected GitHub, the App is not on
          // that owner, the installation cannot see the repository, another
          // workspace already steers by it, or another workspace has linked it.
          case "github_not_authorized":
            return t("githubNotAuthorized");
          case "installation_unreachable":
            return t("installationUnreachable");
          case "repository_not_installed":
            return t("repositoryNotInstalled");
          case "main_repo_claimed":
            return t("mainRepoClaimed");
          case "repository_linked_elsewhere":
            return t("repositoryLinkedElsewhere");
          // Deleting a provider another admin already removed (ADR-142).
          case "sso_provider_not_found":
            return t("ssoProviderNotFound");
          default:
            return t("refused", { code: failure.code });
        }
      case "invalid":
        // A main repository the action could not split into `owner/name`, or
        // one whose owner or name the contract's GitHub-shaped schema refused,
        // is named as such: "refused as invalid" would leave the one field a
        // person has to fix unnamed.
        return failure.code === "repository_unparsable" ||
          failure.field?.startsWith("mainRepo") === true
          ? t("repositoryUnparsable")
          : t("invalid");
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
