// The sentence a refused Organization write shows. The kernel classified the
// refusal and put the handler's HandlerError reason in `code` (§3.2). Each
// reason the bound handlers throw, the role editor's and the workspace
// writes', has its own sentence; any other code is printed as recorded, with
// no cause attached to it. The reading is the kit's (`@/ui/action-failure`);
// only the vocabulary, and the one invalid field named below, is this lane's.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";
import { readFailure, unanswered } from "@/ui/action-failure";

export type ActionFailure = Exclude<ActionResult<unknown>, { ok: true }>;

const WORDS = {
  refused: {
    org_role_required: "orgRoleRequired",
    no_principal: "noPrincipal",
    delegation_ceiling_exceeded: "delegationCeiling",
    role_exists: "roleExists",
    role_not_found: "roleNotFound",
    role_in_use: "roleInUse",
    system_role_readonly: "systemRoleReadonly",
    slug_taken: "slugTaken",
    workspace_not_found: "workspaceNotFound",
    already_archived: "alreadyArchived",
    workspace_has_agents: "workspaceHasAgents",
    // The five ways `create_workspace` can refuse the main repository
    // (MC spec §10.1): the org never connected GitHub, the App is not on
    // that owner, the installation cannot see the repository, another
    // workspace already steers by it, or another workspace has linked it.
    github_not_authorized: "githubNotAuthorized",
    installation_unreachable: "installationUnreachable",
    repository_not_installed: "repositoryNotInstalled",
    main_repo_claimed: "mainRepoClaimed",
    repository_linked_elsewhere: "repositoryLinkedElsewhere",
  },
} as const;

export function useActionFailure(): (failure: ActionFailure) => string {
  const t = useTranslations("organization.actions.failure");
  return (failure) => {
    // A main repository the action could not split into `owner/name`, or
    // one whose owner or name the contract's GitHub-shaped schema refused,
    // is named as such: "refused as invalid" would leave the one field a
    // person has to fix unnamed. The field, not only the code, says so.
    if (
      failure.reason === "invalid" &&
      (failure.code === "repository_unparsable" ||
        failure.field?.startsWith("mainRepo") === true)
    ) {
      return t("repositoryUnparsable");
    }
    const reading = readFailure(WORDS, failure);
    switch (reading.kind) {
      case "named":
        return t(reading.key);
      case "refused":
        return t("refused", { code: reading.code });
      case "invalid":
        return t("invalid");
      case "pendingApproval":
        return t("pendingApproval", {
          accessRequestId: reading.accessRequestId,
        });
      case "unavailable":
        return t("unavailable", { code: reading.code });
    }
  };
}

/** A write that threw before it answered, as the seam would name it. */
export const UNANSWERED: ActionFailure = unanswered("action_failed");
