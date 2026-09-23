"use server";
// Fleet's server writes: the one decision on a parked tool call with the read
// the dialog makes beside it, and the commands an operator sends to a run from
// its row. Every one runs for the workspace viewer the URL names.
//
// **`resolve_approval` is the one billed action of this surface (ADR-115).**
// The contract carries no `noBillingGate`, so the billing admission gate fires
// after IAM and before the handler, and an exhausted organization gets
// `exhausted` with the code the gate raised. The reads around it
// (`list_approvals`, `get_auto_eligibility`) are console reads and meter
// nothing, so opening a card and looking at what a rule said costs nothing.
//
// **This action decides nothing about who may answer.** The handler resolves
// the mandate's consequence tags, reads the workspace's `consequence_roles`
// overrides, checks the mandate's named approvers, and refuses an agent
// principal, all before it touches a row (`assertOrgRole`,
// `assertConsequenceRole`, `assertApprover`; INV-29). A refusal comes back as
// `denied` with the handler's reason in `code`, and nothing changed. The panel
// hides neither button: hiding a control is not a gate, and an operator told
// which role is missing has learned something.
//
// A decision that matches no pending row leaves the handler as
// `conflict / approval_expired` before the recorder runs, so it is never
// billed (#2906).
//
// The commands an operator sends to a run from its row on Fleet (spec §7.4),
// through the kernel seam for the workspace viewer the URL names.
//
// The same `dispatch_command` contract the run's own header calls, with the
// same run target, and only the three commands that carry no prompt content.
// A steer stays on the run page: the contract requires `payload` on it, and
// the text and its delivery mode need the room that dialog gives them.
//
// The command is queued, not applied. A pause takes effect at the next
// boundary the harness reaches and a cancel revokes the run token on a
// best-effort basis, so this answers the command ids the control plane wrote
// and the row says Oxagen took the command rather than that the agent stopped.
import {
  APPROVAL_NOTE_MAX,
  agentApprovalResolve,
} from "@oxagen/oxagen/contracts/agent.approval.resolve";
import { approvalAutoEligibilityGet } from "@oxagen/oxagen/contracts/approval.auto_eligibility.get";
import {
  COMMAND_REASON_MAX,
  tachoCommandDispatch,
} from "@oxagen/oxagen/contracts/tacho.command.dispatch";
import { captureError } from "@oxagen/telemetry";
import {
  type ApprovalSettlement,
  AutoEligibility,
  toApprovalSettlement,
  toAutoEligibility,
} from "@/data/contracts/approvals";
import type { ActionResult } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import { isRowCommand } from "@/shared/row-commands";

/** What the decision answered: the resolution, and the mandate settlement when a mandate parked the call. */
export type ApprovalDecision = {
  approvalId: string;
  resolution: "approved" | "denied";
  mandate: {
    mandateId: string;
    reserved: { measure: string; value: string; unitOrCurrency: string }[];
    outcome: "held" | "released";
  } | null;
};

/** What `get_auto_eligibility` answers, as the dialog reads it. */
export type ApprovalEligibility = {
  /**
   * Who or what closed the request, read from its recorded state; null only
   * while it is still pending (#3521).
   */
  settlement: ApprovalSettlement | null;
  eligibility: AutoEligibility | null;
};

/**
 * Approve or deny one parked call.
 *
 * **A denial carries a reason, and that is enforced here rather than in the
 * markup alone.** The contract's `note` is optional, because an API caller
 * approving a routine call has nothing to add. A denial is the opposite case:
 * the note is the whole record of why a call an agent was authorised to make
 * was refused, and a denial with an empty note leaves the run's chain saying
 * only that somebody said no. A required attribute on a textarea is a courtesy
 * to the person typing, not a rule, so the rule lives on this side of the wire.
 *
 * An approval's note is passed through when there is one and left out when
 * there is not, rather than sent as an empty string, so the record holds a note
 * or holds none.
 */
export async function resolveApprovalAction(
  org: string,
  ws: string,
  input: {
    approvalId: string;
    decision: "approved" | "denied";
    note: string;
  },
): Promise<ActionResult<ApprovalDecision>> {
  const note = input.note.trim();
  if (input.decision === "denied" && note === "") {
    return {
      ok: false,
      reason: "invalid",
      code: "note_required",
      field: "note",
    };
  }
  // The contract bounds the note (#3521). A server action is an endpoint, so
  // an overlong note is refused here with a code the dialog can name, rather
  // than reaching the kernel as a schema refusal.
  if (note.length > APPROVAL_NOTE_MAX) {
    return {
      ok: false,
      reason: "invalid",
      code: "note_too_long",
      field: "note",
    };
  }
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, agentApprovalResolve, {
    approvalId: input.approvalId,
    decision: input.decision,
    ...(note === "" ? {} : { note }),
  });
  return result.ok
    ? {
        ok: true,
        value: {
          approvalId: result.value.approvalId,
          resolution: result.value.resolution,
          mandate: result.value.mandate,
        },
      }
    : result;
}

/**
 * What the auto-approval clause said about this call, read again when the
 * dialog opens.
 *
 * The card's own line comes from `list_approvals` and is as old as the page
 * render. A decision is not: a rule can release the call, or another operator
 * can answer it, between the render and the click. So the dialog reads the row
 * once more and says who resolved it when somebody already has, instead of
 * sending a decision that the handler would refuse as `approval_expired` after
 * the operator had written a reason. Whether it is still open comes from the
 * recorded state, not from whether a resolver is named: a mandate revoke or
 * the request's own expiry closes it with none (#3521).
 *
 * The evaluation itself is still the recorded one, never recomputed (ADR-070):
 * a rule edited since is a different rule than the one that judged this call.
 *
 * A read carried in a write's shape, because INV-19 has every exported function
 * of a `"use server"` module answer with an `ActionResult`. The dialog treats a
 * failure as "not read again" and keeps the recorded line, so a refused or
 * unavailable read never blocks a decision.
 */
export async function readApprovalEligibility(
  org: string,
  ws: string,
  approvalId: string,
  /** Which page is asking, so a refused read names that page's permission. */
  page: "fleet" | "run",
): Promise<ActionResult<ApprovalEligibility>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: approvalAutoEligibilityGet,
    input: { approvalId },
    page,
  });
  if (!read.ok) return readToActionResult(read);
  const view = AutoEligibility.nullable().safeParse(
    toAutoEligibility(read.value.eligibility),
  );
  if (!view.success) {
    captureError({
      error: view.error,
      source: "app",
      orgId: ctx.orgId,
      context: "readApprovalEligibility record_unmappable",
    });
    return { ok: false, reason: "unavailable", code: "record_unmappable" };
  }
  return {
    ok: true,
    value: {
      settlement: toApprovalSettlement(read.value),
      eligibility: view.data,
    },
  };
}

export type QueuedRowCommand = { commandIds: string[] };

/**
 * Queue a pause, resume or cancel for one run. The reason is optional and
 * reaches the model on resume; an empty one is omitted rather than sent as a
 * blank string the contract's `min(1)` would refuse.
 *
 * A server action is an endpoint, so the command is checked against the three
 * this surface sends before the kernel runs. Without that, `steer` and
 * `message` would reach the contract from here with no payload and come back
 * as a schema refusal with nothing a person could act on.
 */
export async function dispatchRunCommand(
  org: string,
  ws: string,
  runId: string,
  command: string,
  reason: string,
): Promise<ActionResult<QueuedRowCommand>> {
  const ctx = await requireViewer(org, ws);
  if (!isRowCommand(command)) {
    return {
      ok: false,
      reason: "invalid",
      code: "row_command",
      field: "command",
    };
  }
  const trimmed = reason.trim();
  if (trimmed.length > COMMAND_REASON_MAX) {
    return {
      ok: false,
      reason: "invalid",
      code: "command_reason",
      field: "reason",
    };
  }
  const result = await kernelWrite(ctx, tachoCommandDispatch, {
    target: { kind: "run", id: runId },
    command,
    ...(trimmed === "" ? {} : { reason: trimmed }),
  });
  return result.ok
    ? { ok: true, value: { commandIds: result.value.commandIds } }
    : result;
}
