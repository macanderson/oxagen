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
// The reading is `action-failure.ts`'s, shared with every lane's writes; the
// vocabulary here is the run commands'. The failure is taken structurally
// rather than as the seam's `ActionResult`, because this layer has no edge to
// the kernel seam. Nothing is lost: every caller passes the seam's own value,
// so a new `reason` on `ActionResult` fails to compile at each call site
// rather than falling through to a sentence that does not fit it.
import { COMMAND_REASON_MAX } from "@oxagen/oxagen/tacho/command-limits";
import { useTranslations } from "next-intl";
import { type ActionFailure, readFailure, unanswered } from "./action-failure";

export type CommandFailure = ActionFailure;

const WORDS = {
  refused: {
    org_role_required: "orgRoleRequired",
    no_principal: "noPrincipal",
    run_not_found: "runNotFound",
    no_connection_point: "noConnectionPoint",
    run_sealed: "runSealed",
    observe_tier: "observeTier",
    run_not_sealed: "runNotSealed",
    digest_only: "digestOnly",
    fork_requires_ledger_run: "forkRequiresLedger",
    replay_grade_below_fork: "gradeBelowFork",
    from_seq_past_seal: "seqPastSeal",
    gap_before_from_seq: "gapBeforeSeq",
  },
  invalid: {
    steer_text: "steerText",
    delivery_mode: "deliveryMode",
    row_command: "rowCommand",
    from_seq: "fromSeq",
    run_b: "runB",
  },
} as const;

export function useActionFailure(): (failure: CommandFailure) => string {
  const t = useTranslations("run.commands.failure");
  return (failure) => {
    // The one sentence that carries a figure: the reason's length limit.
    if (failure.reason === "invalid" && failure.code === "command_reason") {
      return t("commandReason", { max: COMMAND_REASON_MAX });
    }
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

/** A command that threw before it answered, as the seam would name it. */
export const UNANSWERED: CommandFailure = unanswered("command_failed");
