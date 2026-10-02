// The sentence a refused or failed Promote, Dismiss or Restore shows. The
// kernel classified the refusal and put the handler's HandlerError reason in
// `code` (ARCHITECTURE.md §3.2). Each reason promote_memories and
// dismiss_memories throw has its own sentence, and any other code is printed
// as recorded. Every sentence says that nothing changed, because a refused
// write moves no memory.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";

export type MemoryWriteFailure = Exclude<ActionResult<unknown>, { ok: true }>;

/** A write that threw before it answered, as the seam would name it. */
export const UNANSWERED: MemoryWriteFailure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};

export function useMemoryWriteFailure(): (
  failure: MemoryWriteFailure,
) => string {
  const t = useTranslations("steering.memories.failure");
  return (failure) => {
    switch (failure.reason) {
      case "denied":
      case "not_found":
      case "conflict":
        switch (failure.code) {
          case "org_role_required":
          case "no_principal":
            return t("denied");
          case "steering_repo_required":
            return t("steeringRepoRequired");
          case "memory_pr_full":
            return t("memoryPrFull");
          case "memory_pr_settled":
            return t("memoryPrSettled");
          case "memory_branch_taken":
            return t("memoryBranchTaken");
          case "force_not_allowed":
            return t("forceNotAllowed");
          case "effect_required":
          case "effect_not_allowed":
            return t("effect");
          case "record_unreadable":
            return t("recordUnreadable");
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
