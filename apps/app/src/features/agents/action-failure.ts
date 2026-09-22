// The sentence a refused agent write shows. The kernel classified the refusal
// and put the handler's HandlerError reason in `code` (§3.2). Each reason the
// bound handlers (rotate, suspend, retire, commit, request a mandate) throw
// has its own sentence; any other code is printed as recorded, with no cause
// attached to it. The reading is the kit's (`@/ui/action-failure`); only the
// vocabulary is this lane's.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";
import { readFailure, unanswered } from "@/ui/action-failure";

export type ActionFailure = Exclude<ActionResult<unknown>, { ok: true }>;

const WORDS = {
  refused: {
    org_role_required: "orgRoleRequired",
    no_principal: "noPrincipal",
    delegation_ceiling: "delegationCeiling",
    agent_not_found: "agentNotFound",
    agent_retired: "agentRetired",
    agent_principal_missing: "agentPrincipalMissing",
    no_repository: "noRepository",
    repository_ambiguous: "repositoryAmbiguous",
    branch_is_default: "branchIsDefault",
    definition_schema: "definitionSchema",
    definition_slug: "definitionSlug",
    agent_has_no_principal: "agentPrincipalMissing",
    no_tool_matches: "noToolMatches",
    measure_not_declared: "measureNotDeclared",
    measure_unit_mismatch: "measureUnitMismatch",
    measure_kind_conflict: "measureKindConflict",
    // Not a handler reason: the action refuses before it writes, because a
    // guessed zone moves a validity boundary by up to a day.
    // `time_zone_unavailable` is its retryable twin, under `unavailable`.
    time_zone_unsupported: "timeZoneUnsupported",
  },
  unavailable: { time_zone_unavailable: "timeZoneUnavailable" },
} as const;

export function useActionFailure(): (failure: ActionFailure) => string {
  const t = useTranslations("agents.actions.failure");
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
