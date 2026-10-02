// The sentence a refused Work item write shows. The kernel classified the
// refusal and put the handler's reason in `code` (ARCHITECTURE.md §3.2), so
// each reason the Work actions give (ADR-251) has a sentence a person can act
// on. A stale read is the common one: someone else changed the item after the
// page read it, so the page asks for a reload. Any other code is printed as
// recorded, with no cause invented for it. The reading is the kit's
// (`@/ui/action-failure`); only the words are this page's.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";
import { readFailure, unanswered } from "@/ui/action-failure";

export type ActionFailure = Exclude<ActionResult<unknown>, { ok: true }>;

const WORDS = {
  refused: {
    stale_version: "stale",
    stale_revision: "stale",
    stale_brief: "stale",
    conflict: "stale",
    stale_head: "staleHead",
    not_allowed: "notAllowed",
    person_required: "personRequired",
    agent_run: "agentRun",
    org_role_required: "roleRequired",
    work_forbidden: "roleRequired",
  },
} as const;

export function useActionFailure(): (failure: ActionFailure) => string {
  const t = useTranslations("workItem.failure");
  return (failure) => {
    // An item or a send the store no longer finds: whatever the code, the
    // page is out of date.
    if (failure.reason === "not_found") return t("notFound");
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
