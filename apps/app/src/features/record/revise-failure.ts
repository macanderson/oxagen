// The sentence a refused revision shows (#3395). `revise_context_record`
// refuses on its own two reasons and then hands the proposal to
// `open_context_pr`, so every reason that call throws reaches here too.
// Anything else is printed with its code attached rather than flattened into
// "something went wrong": the code is what a reader pastes into an incident.
// The reading is the kit's (`@/ui/action-failure`); only the vocabulary is
// this lane's.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";
import { readFailure, unanswered } from "@/ui/action-failure";

type ReviseFailure = Exclude<ActionResult<unknown>, { ok: true }>;

const WORDS = {
  refused: {
    org_role_required: "orgRoleRequired",
    no_principal: "noPrincipal",
    record_not_found: "recordNotFound",
    record_unclassified: "recordUnclassified",
    constraint_effect_unknown: "constraintEffectUnknown",
    lineage_pr_open: "lineagePrOpen",
    workspace_repository_missing: "repositoryMissing",
    governance_unreadable: "governanceUnreadable",
    github_refused: "githubRefused",
  },
} as const;

export function useReviseFailure(): (failure: ReviseFailure) => string {
  const t = useTranslations("record.failure");
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
export const UNANSWERED: ReviseFailure = unanswered("action_failed");
