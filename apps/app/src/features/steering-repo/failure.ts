// The sentence a refused steering repo write shows. The kernel classified the
// refusal and put the handler's reason in `code`. A write the platform has not
// registered yet answers `tool_not_registered`, and the sentence names the
// capability it needs. Any other code is printed as recorded.
import { useTranslations } from "next-intl";
import type { ActionResult } from "@/server/kernel";

type SteeringRepoFailure = Exclude<ActionResult<unknown>, { ok: true }>;

export function useSteeringRepoFailure(): (
  failure: SteeringRepoFailure,
  /** The capability the write called, such as `repair_steering_repo`. */
  capability: string,
) => string {
  const t = useTranslations("repositories.steeringRepo.failure");
  return (failure, capability) => {
    switch (failure.reason) {
      case "denied":
        return t("denied");
      case "invalid":
        return t("invalid");
      case "not_found":
      case "conflict":
        return t("refused", { code: failure.code });
      case "pending_approval":
        return t("pendingApproval", {
          accessRequestId: failure.accessRequestId,
        });
      case "exhausted":
      case "unavailable":
        // The kernel answers a capability no handler registered with
        // `tool_not_registered`, before it reads the input (#4518).
        return failure.code === "tool_not_registered"
          ? t("toolNotRegistered", { capability })
          : t("unavailable", { code: failure.code });
    }
  };
}

/** A write that threw before it answered, as the seam would name it. */
export const UNANSWERED: SteeringRepoFailure = {
  ok: false,
  reason: "unavailable",
  code: "action_failed",
};
