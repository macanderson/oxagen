// The sentence a refused grant shows. The kernel classified the refusal and put
// the handler's HandlerError reason in `code` (ARCHITECTURE.md §3.2), so each
// reason `grant_mandate` throws has its own sentence and any other code is
// printed as recorded. The handler checks roles, the agent, the draft and the
// tools before it writes, so every sentence can say nothing was granted.
//
// A refusal the action made before the kernel names the field, because the
// dialog knows which field that is and a person should not have to hunt for it.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";
import type { GrantDraft } from "./grant-actions";

type ActionFailure = Exclude<ActionResult<unknown>, { ok: true }>;

/** The draft fields the dialog labels, so an `invalid` refusal can name one. */
const FIELDS: ReadonlySet<string> = new Set<keyof GrantDraft>([
  "agentId",
  "consequenceTags",
  "measure",
  "unit",
  "perCall",
  "perPeriod",
  "callsPerDay",
  "tools",
  "targetMeasure",
  "targetAllow",
  "targetDeny",
  "alwaysHumanFor",
  "humanAboveMeasure",
  "humanAboveValue",
  "approvers",
  "purpose",
  "validFrom",
  "validTo",
]);

function isField(
  field: string | undefined,
): field is Exclude<keyof GrantDraft, "requestId" | "period"> {
  return field !== undefined && FIELDS.has(field);
}

export function useGrantFailure(): (failure: ActionFailure) => string {
  const t = useTranslations("tools.grant.failure");
  const label = useTranslations("tools.grant.fields");
  return (failure) => {
    switch (failure.reason) {
      case "denied":
      case "not_found":
      case "conflict":
        switch (failure.code) {
          case "org_role_required":
            return t("orgRoleRequired");
          case "no_role_covers_all_tags":
            return t("noRoleCoversAllTags");
          case "no_principal":
            return t("noPrincipal");
          case "agent_not_found":
            return t("agentNotFound");
          case "agent_has_no_principal":
            return t("agentHasNoPrincipal");
          case "mandate_not_found":
            return t("mandateNotFound");
          case "not_a_draft":
            return t("notADraft");
          case "no_tool_matches":
            return t("noToolMatches");
          case "measure_not_declared":
            return t("measureNotDeclared");
          case "measure_unit_mismatch":
            return t("measureUnitMismatch");
          // Not a handler reason: the action refuses before it writes, because
          // a guessed zone moves a validity boundary by up to a day.
          case "time_zone_unsupported":
            return t("timeZoneUnsupported");
          default:
            return t("refused", { code: failure.code });
        }
      case "invalid":
        return isField(failure.field)
          ? t("invalidField", { field: label(failure.field) })
          : t("invalid");
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

/** A write that threw before it answered, as the seam would have named it. */
export const UNANSWERED: ActionFailure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};
