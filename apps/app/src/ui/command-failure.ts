// The sentence a refused run command shows. The kernel classified the refusal
// and put the handler's reason in `code` (§3.2); each reason `dispatch_command`
// throws has its own sentence, and any other code is printed as recorded with
// no cause attached to it.
//
// It sits in the UI kit because two pages send run commands: the run's own
// header and a run's row on Fleet. A lane may not import another lane's
// internals (ARCHITECTURE.md §2), so a sentence kept in one of them would be
// copied into the other, and two copies of a refusal vocabulary drift.
//
// The failure is taken structurally rather than as the seam's `ActionResult`,
// because this layer has no edge to the kernel seam. Nothing is lost: every
// caller passes the seam's own value, so a new `reason` on `ActionResult`
// fails to compile at each call site rather than falling through to a
// sentence that does not fit it.
import { COMMAND_REASON_MAX } from "@oxagen/oxagen/tacho/command-limits";
import { useTranslations } from "next-intl";

export type CommandFailure =
  | {
      ok: false;
      reason:
        | "denied"
        | "invalid"
        | "not_found"
        | "conflict"
        | "unavailable"
        | "exhausted";
      code: string;
      field?: string;
    }
  | { ok: false; reason: "pending_approval"; accessRequestId: string };

export function useActionFailure(): (failure: CommandFailure) => string {
  const t = useTranslations("run.commands.failure");
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
          case "run_not_found":
            return t("runNotFound");
          case "no_connection_point":
            return t("noConnectionPoint");
          case "run_sealed":
            return t("runSealed");
          case "observe_tier":
            return t("observeTier");
          case "run_not_sealed":
            return t("runNotSealed");
          case "digest_only":
            return t("digestOnly");
          case "fork_requires_ledger_run":
            return t("forkRequiresLedger");
          case "replay_grade_below_fork":
            return t("gradeBelowFork");
          case "from_seq_past_seal":
            return t("seqPastSeal");
          case "gap_before_from_seq":
            return t("gapBeforeSeq");
          default:
            return t("refused", { code: failure.code });
        }
      case "invalid":
        switch (failure.code) {
          case "steer_text":
            return t("steerText");
          case "delivery_mode":
            return t("deliveryMode");
          case "command_reason":
            return t("commandReason", { max: COMMAND_REASON_MAX });
          case "row_command":
            return t("rowCommand");
          case "from_seq":
            return t("fromSeq");
          case "run_b":
            return t("runB");
          default:
            return t("invalid");
        }
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

/** A command that threw before it answered, as the seam would name it. */
export const UNANSWERED: CommandFailure = {
  ok: false,
  reason: "unavailable",
  code: "command_failed",
};
