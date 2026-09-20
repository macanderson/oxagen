"use server";
// The one decision on a parked tool call, and the read the dialog makes beside
// it, for the workspace viewer the URL names.
//
// **`resolve_approval` is the one billed action of this surface (ADR-113).**
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
import { agentApprovalResolve } from "@oxagen/oxagen/contracts/agent.approval.resolve";
import { approvalAutoEligibilityGet } from "@oxagen/oxagen/contracts/approval.auto_eligibility.get";
import { captureError } from "@oxagen/telemetry";
import { AutoEligibility } from "@/data/contracts/approvals";
import type { ActionResult } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

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
  /** `user:<usr_…>` or `policy:<rule id>`; null while the call is still waiting. */
  resolvedBy: string | null;
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
 * the operator had written a reason.
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
): Promise<ActionResult<ApprovalEligibility>> {
  const ctx = await requireViewer(org, ws);
  const read = await kernelRead(ctx, {
    contract: approvalAutoEligibilityGet,
    input: { approvalId },
    page: "fleet",
  });
  if (!read.ok) return readToActionResult(read);
  const view = AutoEligibility.nullable().safeParse(read.value.eligibility);
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
    value: { resolvedBy: read.value.resolvedBy, eligibility: view.data },
  };
}
