// The sentence a refused Repositories page read or write shows. The kernel
// seam classified the refusal and put the handler's reason in `code` (§3.2);
// every reason `get_main_repository`, `list_installation_repositories`,
// `list_github_installations`, `attach_github_installation`,
// `bind_main_repository`, `list_repositories`, `link_repository`,
// `unlink_repository`, `get_repository_tree`, `set_production_branch` and
// `open_init_pr` can give has its own sentence, and any other code is printed
// as recorded rather than collapsed into "something went wrong".
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";

export type RepositoriesFailure = Exclude<ActionResult<unknown>, { ok: true }>;

export function useRepositoriesFailure(): (
  failure: RepositoriesFailure,
) => string {
  const t = useTranslations("repositories.failure");
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
          // The Repositories section's link and unlink (§10.1).
          case "main_repo":
            return t("mainRepo");
          case "repository_already_linked":
            return t("repositoryAlreadyLinked");
          case "main_repo_claimed":
            return t("mainRepoClaimed");
          case "main_repo_unbound":
            return t("mainRepoUnbound");
          case "repository_linked_elsewhere":
            return t("repositoryLinkedElsewhere");
          case "main_repo_unlink_refused":
            return t("mainRepoUnlinkRefused");
          case "repository_not_linked":
            return t("repositoryNotLinked");
          // The production branch and the init pull request (§10.2, §11.4).
          case "branch_not_found":
            return t("branchNotFound");
          case "production_branch_missing":
            return t("productionBranchMissing");
          case "production_branch_is_init_branch":
            return t("productionBranchIsInitBranch");
          case "oxagen_tree_exists":
            return t("oxagenTreeExists");
          case "governance_toml_invalid":
            return t("governanceTomlInvalid");
          case "workspace_toml_invalid":
            return t("workspaceTomlInvalid");
          case "secret_found":
            return t("secretFound");
          case "authority_declared":
            return t("authorityDeclared");
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

/** A call that threw before it answered, as the seam would name it. */
export const UNANSWERED: RepositoriesFailure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};
