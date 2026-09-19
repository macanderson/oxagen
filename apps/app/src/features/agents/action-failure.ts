// The sentence a refused agent write shows. The kernel classified the refusal
// and put the handler's HandlerError reason in `code` (§3.2). Each reason the
// bound handlers (rotate, suspend, retire, commit, request a mandate) throw
// has its own sentence; any other code is printed as recorded, with no cause
// attached to it.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";

export type ActionFailure = Exclude<ActionResult<unknown>, { ok: true }>;

export function useActionFailure(): (failure: ActionFailure) => string {
  const t = useTranslations("agents.actions.failure");
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
          case "delegation_ceiling":
            return t("delegationCeiling");
          case "agent_not_found":
            return t("agentNotFound");
          case "agent_retired":
            return t("agentRetired");
          case "agent_principal_missing":
            return t("agentPrincipalMissing");
          case "no_repository":
            return t("noRepository");
          case "repository_ambiguous":
            return t("repositoryAmbiguous");
          case "branch_is_default":
            return t("branchIsDefault");
          case "definition_schema":
            return t("definitionSchema");
          case "definition_slug":
            return t("definitionSlug");
          case "agent_has_no_principal":
            return t("agentPrincipalMissing");
          case "no_tool_matches":
            return t("noToolMatches");
          case "measure_not_declared":
            return t("measureNotDeclared");
          case "measure_unit_mismatch":
            return t("measureUnitMismatch");
          case "measure_kind_conflict":
            return t("measureKindConflict");
          // Not a handler reason: the action refuses before it writes, because a
          // guessed zone moves a validity boundary by up to a day.
          // `time_zone_unavailable` is its retryable twin, under `unavailable`.
          case "time_zone_unsupported":
            return t("timeZoneUnsupported");
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
        return t("unavailable", { code: failure.code });
      case "unavailable":
        return failure.code === "time_zone_unavailable"
          ? t("timeZoneUnavailable")
          : t("unavailable", { code: failure.code });
    }
  };
}

/** A write that threw before it answered, as the seam would name it. */
export const UNANSWERED: ActionFailure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};
