// admit.ts: whether a person's action fits the item as its facts stand now.
//
// The store reduces the item's facts under a row lock, then asks admitDecision
// before it appends anything. Each refusal is a WorkRecordError whose code
// says why: a stale revision, brief, or head means the caller read the item
// before something changed and must read it again, and not_allowed means the
// state forbids the action whatever the caller read. The version check (any
// change since the read) happens in the store, before this.
//
// admitDecision answers `repeat: true` for an action that is already recorded
// exactly as asked, so a retried request changes nothing and does not fail.
import type { Sha256Digest } from "@oxagen/run-evidence";
import type { WorkItemPublicId } from "./brief";
import { WorkRecordError } from "./errors";
import { workOrderKey } from "./facts";
import { type OrderProjection, type WorkItemProjection, reviewGate } from "./reduce";

/** A person's action on a work item. */
export type WorkItemDecision =
  | { kind: "save_brief"; itemRevision: number }
  | { kind: "approve_brief"; itemRevision: number; briefRevision: number; briefDigest: Sha256Digest }
  | {
      kind: "send";
      item: WorkItemPublicId;
      itemRevision: number;
      briefRevision: number;
      briefDigest: Sha256Digest;
      key: string;
    }
  | { kind: "withdraw"; orderId: string }
  | { kind: "stop"; orderId: string }
  | { kind: "return"; orderId: string }
  | {
      kind: "accept";
      orderId: string;
      headSha: string;
      briefDigest: Sha256Digest;
      /** The criterion ids the person ticked. */
      criteria: readonly string[];
      /** Every criterion id of the brief being accepted against. */
      briefCriteria: readonly string[];
    }
  | { kind: "close" }
  | { kind: "reopen" }
  | { kind: "override_triage" };

/** The answer for an admitted action. */
export interface Admitted {
  /** The action is already recorded as asked. Record nothing more. */
  repeat: boolean;
}

const ADMITTED: Admitted = { repeat: false };
const REPEAT: Admitted = { repeat: true };

function refuse(code: WorkRecordError["code"], message: string): never {
  throw new WorkRecordError(code, message);
}

function requireOpen(item: WorkItemProjection, verb: string): void {
  if (item.state === "closed") refuse("not_allowed", `The work item is closed. Reopen it before you ${verb}.`);
  if (item.state === "done") refuse("not_allowed", `The work item is done. Reopen it before you ${verb}.`);
}

function requireRevision(item: WorkItemProjection, itemRevision: number): void {
  if (itemRevision !== item.revision) {
    refuse(
      "stale_revision",
      `You read revision ${itemRevision} of the work item, and it is now at revision ${item.revision}. Read it again.`,
    );
  }
}

function findOrder(item: WorkItemProjection, orderId: string): OrderProjection {
  const order = item.orders.find((entry) => entry.orderId === orderId);
  if (order === undefined) refuse("not_found", "This work item has no such send.");
  return order;
}

function admitApprove(item: WorkItemProjection, action: Extract<WorkItemDecision, { kind: "approve_brief" }>): Admitted {
  requireOpen(item, "approve its brief");
  requireRevision(item, action.itemRevision);
  const latest = item.latestBrief;
  if (latest === null) refuse("not_allowed", "The work item has no brief to approve. Save a brief first.");
  if (item.approvedBrief !== null) {
    if (item.approvedBrief.digest === action.briefDigest) return REPEAT;
    refuse("not_allowed", `Revision ${item.revision} already has an approved brief.`);
  }
  if (action.briefRevision !== latest.revision || action.briefDigest !== latest.digest) {
    refuse(
      "stale_brief",
      `You read brief revision ${action.briefRevision}, and the latest is revision ${latest.revision}. Read the brief again.`,
    );
  }
  if (latest.itemRevision !== item.revision) {
    refuse(
      "stale_revision",
      `Brief revision ${latest.revision} was written against item revision ${latest.itemRevision}, and the item is at revision ${item.revision}. Save the brief again for the current revision.`,
    );
  }
  if (item.triage.outcome === "needs_info") refuse("not_allowed", "Triage has an open question. Answer it before you approve the brief.");
  if (item.triage.outcome === "duplicate" || item.triage.outcome === "out_of_scope") {
    refuse("not_allowed", "Triage holds this item as a duplicate or out of scope. Keep it separate before you approve the brief.");
  }
  return ADMITTED;
}

function admitSend(item: WorkItemProjection, action: Extract<WorkItemDecision, { kind: "send" }>): Admitted {
  requireOpen(item, "send it");
  if (item.activeOrder !== null) {
    refuse("not_allowed", `Send ${item.activeOrder.send} is still open. Withdraw, stop, or finish it before you send again.`);
  }
  requireRevision(item, action.itemRevision);
  const approved = item.approvedBrief;
  if (approved === null) refuse("not_allowed", `Revision ${item.revision} has no approved brief. Approve the brief before you send.`);
  if (action.briefRevision !== approved.revision || action.briefDigest !== approved.digest) {
    refuse(
      "stale_brief",
      `You are sending brief revision ${action.briefRevision}, and the approved brief is revision ${approved.revision}. Read the item again.`,
    );
  }
  const expected = workOrderKey(action.item, approved.revision, item.nextSend);
  if (action.key !== expected) {
    refuse("stale_version", `The send key ${action.key} does not name the next send, ${expected}. Read the item again.`);
  }
  return ADMITTED;
}

function admitAccept(item: WorkItemProjection, action: Extract<WorkItemDecision, { kind: "accept" }>): Admitted {
  requireOpen(item, "accept work");
  const order = findOrder(item, action.orderId);
  if (order.acceptance !== null && order.acceptance.headSha === action.headSha && order.acceptance.briefDigest === action.briefDigest) {
    return REPEAT;
  }
  if (order.head !== null && action.headSha !== order.head) {
    refuse(
      "stale_head",
      `You reviewed ${action.headSha.slice(0, 7)}, and the pull request's head is now ${order.head.slice(0, 7)}. Review the new head.`,
    );
  }
  if (item.approvedBrief !== null && action.briefDigest !== item.approvedBrief.digest) {
    refuse("stale_brief", `You accepted against a brief that is not the approved brief of revision ${item.revision}. Read the item again.`);
  }
  const gate = reviewGate(item, order);
  if (!gate.open) {
    const detail = gate.detail === null ? "" : ` (${gate.detail})`;
    const messages: Record<typeof gate.block, string> = {
      order_closed: "This send is over. Accept the current send.",
      already_accepted: "This send is already accepted on another head.",
      run_active: "The run has not ended. Wait for it, or stop it.",
      pr_closed: "The pull request closed without merging. Return the work or close the item.",
      no_pull_request: "The send has no pull request. Phase 1 accepts work only through a pull request.",
      no_head: "The pull request has no head commit yet.",
      brief_out_of_date: `The item changed to revision ${item.revision}. Approve the new brief before you accept.`,
      checks_unknown: "Oxagen has not read the required checks for this head. Read them again before you accept.",
      check_missing: "A required check has not reported on this head.",
      check_failed: "A required check did not pass on this head.",
    };
    refuse(gate.block === "brief_out_of_date" ? "stale_brief" : "not_allowed", `${messages[gate.block]}${detail}`);
  }
  const ticked = new Set(action.criteria);
  for (const id of ticked) {
    if (!action.briefCriteria.includes(id)) refuse("invalid_input", `The brief has no criterion "${id}".`);
  }
  const missing = action.briefCriteria.filter((id) => !ticked.has(id));
  if (missing.length > 0) {
    refuse("not_allowed", `Tick every criterion before you accept. Not ticked: ${missing.join(", ")}.`);
  }
  return ADMITTED;
}

/**
 * Admit a person's action against the item's current projection, or throw a
 * WorkRecordError that says why not. Pure.
 */
export function admitDecision(item: WorkItemProjection, action: WorkItemDecision): Admitted {
  switch (action.kind) {
    case "save_brief":
      requireOpen(item, "edit its brief");
      requireRevision(item, action.itemRevision);
      return ADMITTED;
    case "approve_brief":
      return admitApprove(item, action);
    case "send":
      return admitSend(item, action);
    case "withdraw": {
      // A send no runtime claimed is Oxagen's, so it can be withdrawn at once.
      // A claimed send is stopped first. If the runtime claimed it, a stop was
      // asked for, and no run ever linked (the host went away), a person may
      // then withdraw it: the send ends, and a run that links later is
      // cancelled when it does (ADR-251), so nothing runs it twice.
      const order = findOrder(item, action.orderId);
      if (order.delivery === "withdrawn") return REPEAT;
      if (order.closed) refuse("not_allowed", "This send is over.");
      if (order.runIds.length > 0) refuse("not_allowed", "A run is linked to this send. Stop the run instead.");
      if (order.delivery !== "waiting_for_claim" && order.delivery !== "stopping") {
        refuse(
          "not_allowed",
          "A runtime claimed this send. Stop it first. If the runtime never confirms the stop, withdraw the send then.",
        );
      }
      return ADMITTED;
    }
    case "stop": {
      const order = findOrder(item, action.orderId);
      if (order.delivery === "stopping" || order.delivery === "stopped") return REPEAT;
      if (order.closed) refuse("not_allowed", "This send is over.");
      if (order.delivery === "waiting_for_claim") refuse("not_allowed", "No runtime has claimed this send. Withdraw it instead.");
      if (order.delivery === "run_ended") refuse("not_allowed", "The run has ended. Return the work or accept it.");
      return ADMITTED;
    }
    case "return": {
      const order = findOrder(item, action.orderId);
      if (order.delivery === "returned") return REPEAT;
      if (order.closed) refuse("not_allowed", "This send is over.");
      if (order.delivery !== "run_ended" && order.merge === null && !order.prClosed) {
        refuse("not_allowed", "The run has not ended. Stop it before you return the work.");
      }
      return ADMITTED;
    }
    case "accept":
      return admitAccept(item, action);
    case "close": {
      if (item.state === "closed") return REPEAT;
      if (item.state === "done") refuse("not_allowed", "The work item is done. Reopen it to change its resolution.");
      const order = item.activeOrder;
      if (order !== null && order.delivery !== "run_ended" && order.merge === null && !order.prClosed) {
        refuse("not_allowed", `Send ${order.send} is still out. Withdraw or stop it before you close the item.`);
      }
      return ADMITTED;
    }
    case "reopen":
      if (item.state !== "closed" && item.state !== "done") refuse("not_allowed", "Only a closed or done work item can be reopened.");
      return ADMITTED;
    case "override_triage":
      requireOpen(item, "change its triage");
      return ADMITTED;
  }
}
