// The sentence a refused Organization write shows. The kernel classified the
// refusal and put the handler's HandlerError reason in `code` (§3.2). Each
// reason the bound handlers throw, the role editor's and the workspace
// writes', has its own sentence; any other code is printed as recorded, with
// no cause attached to it. The reading is the kit's (`@/ui/action-failure`);
// only the vocabulary is this lane's. `create_workspace` takes no repository
// any more (lane S1, #4450), so none of its refusals names one.
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
    // Deleting a provider another admin already removed (ADR-145).
    sso_provider_not_found: "ssoProviderNotFound",
    // The SCIM token dialogs on Organization › Single sign-on (#3734).
    sso_requires_enterprise: "ssoRequiresEnterprise",
    scim_token_exists: "scimTokenExists",
    scim_token_changed: "scimTokenChanged",
  },
} as const;

export function useActionFailure(): (failure: ActionFailure) => string {
  const t = useTranslations("organization.actions.failure");
  return (failure) => {
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
