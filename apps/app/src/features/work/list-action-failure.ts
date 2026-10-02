// The sentence a refused write on the Work page or Work setup shows: entering
// a work item, saving a collector, and reading a collector again. The kernel
// classified the refusal and put the handler's HandlerError reason in `code`
// (ARCHITECTURE.md §3.2). Each reason the three handlers throw has its own
// sentence, and any other code is printed as recorded with no cause added.
// The reading is the kit's (`@/ui/action-failure`). Only the words are this
// lane's. The item page words its own actions (./item/).
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";
import { readFailure, unanswered } from "@/ui/action-failure";

type ListActionFailure = Exclude<ActionResult<unknown>, { ok: true }>;

const WORDS = {
  refused: {
    // packages/handlers/src/lib/capability-role-guard.ts `assertContractRole`.
    org_role_required: "workForbidden",
    // The write names no signed-in person to record as the actor.
    person_required: "personRequired",
    // packages/handlers/src/lib/work-intake/handler-support.ts `workRefusal`.
    work_forbidden: "workForbidden",
    collector_not_found: "collectorNotFound",
    collector_conflict: "collectorConflict",
    // packages/handlers/src/work.collector.sync.ts.
    collector_paused: "collectorPaused",
  },
} as const;

export function useListActionFailure(): (
  failure: ListActionFailure,
) => string {
  const t = useTranslations("work.failure");
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
export const UNANSWERED: ListActionFailure = unanswered("action_failed");
