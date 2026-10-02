// What the Work item page decides from one item's record (roadmap
// mockups/src/work.js `itemActions()`, `reviewGate()`, `briefPanel()`, and the
// `wrk-approve`, `wrk-stop` and `send` handlers): which actions the head offers
// for the item's status, which of them the viewer's roles or the record hold
// back and why, how Approve reaches an approved brief, and the facts the
// panels share.
//
// Everything here is pure, with no hook and no JSX, so the server components
// and the client islands read the same answers. The server decides the item's
// status, what it waits for, and whether Accept is open (get_work_item). These
// helpers only pick among those answers. They never decide a verdict.
import type {
  BriefRevision,
  CheckConclusion,
  DeliveryState,
  ReviewBlock,
  RuntimeTier,
  WorkCheck,
  WorkItemDetail,
  WorkSend,
} from "@/data/contracts/work";
import type { CriterionDraft } from "../actions";

/** One item as the client islands receive it: everything but the history. */
export type ItemData = Omit<WorkItemDetail, "history">;

/** The record without its history, for a client island. */
export function itemData(detail: WorkItemDetail): ItemData {
  return {
    item: detail.item,
    triage: detail.triage,
    brief: detail.brief,
    nextSend: detail.nextSend,
    sends: detail.sends,
    viewer: detail.viewer,
  };
}

/** The newest saved brief revision, or null when none is saved. */
export function latestBrief(detail: Pick<ItemData, "brief">): BriefRevision | null {
  let latest: BriefRevision | null = null;
  for (const revision of detail.brief.revisions) {
    if (latest === null || revision.revision > latest.revision) latest = revision;
  }
  return latest;
}

/** The newest brief approved for the item's current revision: the one a send carries. */
export function approvedBrief(
  detail: Pick<ItemData, "brief" | "item">,
): BriefRevision | null {
  let found: BriefRevision | null = null;
  for (const revision of detail.brief.revisions) {
    if (revision.approved === null) continue;
    if (revision.itemRevision !== detail.item.revision) continue;
    if (found === null || revision.revision > found.revision) found = revision;
  }
  return found;
}

/** The brief revision a send ran on, or the newest one when the record lacks it. */
export function briefOfSend(
  detail: Pick<ItemData, "brief">,
  send: WorkSend,
): BriefRevision | null {
  return (
    detail.brief.revisions.find((r) => r.revision === send.briefRevision) ??
    latestBrief(detail)
  );
}

/** The newest send. `sends` is newest first. */
export function latestSend(detail: Pick<ItemData, "sends">): WorkSend | null {
  return detail.sends[0] ?? null;
}

/**
 * The criteria the brief editor opens with, and the ones Approve saves when
 * no saved revision fits: the newest saved revision's, each keeping its key,
 * or else triage's draft as new criteria.
 */
export function draftCriteria(
  detail: Pick<ItemData, "brief">,
): CriterionDraft[] {
  const latest = latestBrief(detail);
  if (latest !== null) {
    return latest.criteria.map((c) => ({
      criterion: c.criterion,
      text: c.text,
      tag: c.tag,
      intent: c.intent,
      evidence: c.evidence,
      provenance: c.provenance,
    }));
  }
  return detail.brief.triageCriteria.map((text) => ({
    criterion: null,
    text,
    tag: "code",
    intent: "review",
    evidence: "",
    provenance: "triage",
  }));
}

/**
 * The repository the work changes, as owner/name: the brief's, else the
 * newest saved revision's, else the item's. Null when nothing names one.
 */
export function briefRepository(
  detail: Pick<ItemData, "brief" | "item">,
): string | null {
  return (
    detail.brief.repository ??
    latestBrief(detail)?.repository ??
    detail.item.repository
  );
}

/**
 * How Approve reaches an approved brief. A draft saved for the item's current
 * revision is approved as it stands (approve_work_brief with its revision and
 * digest). Anything else, a triage draft or a brief written for an older
 * revision, is saved for the current revision first and then approved
 * (`saveAndApproveBrief`). `revision` is the brief revision the approval
 * records, which the button names after the source changed.
 */
export type ApprovePlan =
  | { kind: "approve"; revision: number; digest: string }
  | {
      kind: "save-and-approve";
      revision: number;
      repository: string;
      criteria: CriterionDraft[];
    }
  | { kind: "needs-repository"; revision: number }
  | { kind: "nothing" };

export function approvePlan(detail: Pick<ItemData, "brief" | "item">): ApprovePlan {
  const latest = latestBrief(detail);
  if (
    latest !== null &&
    latest.itemRevision === detail.item.revision &&
    latest.approved === null
  ) {
    return { kind: "approve", revision: latest.revision, digest: latest.digest };
  }
  const criteria = draftCriteria(detail);
  if (criteria.length === 0) return { kind: "nothing" };
  const revision = latest === null ? 1 : latest.revision + 1;
  const repository = briefRepository(detail);
  return repository === null
    ? { kind: "needs-repository", revision }
    : { kind: "save-and-approve", revision, repository, criteria };
}

/** Every action the head can offer. Each is a button with `data-testid="work-action-<name>"`. */
export type HeadActionName =
  | "correct-triage"
  | "retry-triage"
  | "keep-separate"
  | "keep-in-scope"
  | "confirm-duplicate"
  | "edit-brief"
  | "approve"
  | "send"
  | "cancel"
  | "stop"
  | "withdraw"
  | "open-run"
  | "open-pr"
  | "return"
  | "accept"
  | "close"
  | "reopen";

export type HeadAction = {
  name: HeadActionName;
  /** One primary action per screen, last in the row. Ending a send or a run reads as danger. */
  tone: "primary" | "secondary" | "danger";
};

function action(
  name: HeadActionName,
  tone: HeadAction["tone"] = "secondary",
): HeadAction {
  return { name, tone };
}

/** The head's actions for the item's status (pages/work-item.md, States), the primary last. */
export function headActions(detail: ItemData): HeadAction[] {
  const send = latestSend(detail);
  const hasRun = send !== null && send.runs.length > 0;
  switch (detail.item.status) {
    case "triaging":
    case "needs_info":
      return [];
    case "triage_failed":
      return [action("correct-triage"), action("retry-triage", "primary")];
    case "possible_duplicate":
      return [action("keep-separate"), action("confirm-duplicate", "primary")];
    case "out_of_scope":
      return [action("keep-in-scope"), action("close", "primary")];
    case "brief_to_approve":
      return approvePlan(detail).kind === "nothing"
        ? [action("edit-brief", "primary")]
        : [action("edit-brief"), action("approve", "primary")];
    case "changed":
      // The source changed, so the brief may need new criteria before it is
      // approved again: Edit brief is the primary here (the mockup's order).
      return [action("approve"), action("edit-brief", "primary")];
    case "ready":
    case "send_rejected":
      return [action("close"), action("send", "primary")];
    case "waiting_for_claim":
    case "no_answer":
      return [action("cancel", "danger")];
    case "running": {
      const out: HeadAction[] = hasRun ? [action("open-run")] : [];
      if (send?.delivery === "waiting_for_claim") out.push(action("cancel", "danger"));
      else if (send?.delivery === "claimed" || send?.delivery === "running")
        out.push(action("stop", "danger"));
      return out;
    }
    case "stopping":
      // A stop waits for the runtime. A send no run started can be withdrawn.
      return hasRun ? [action("open-run")] : [action("withdraw", "danger")];
    case "in_review": {
      const pr = send?.pullRequest ?? null;
      if (pr === null) return [action("close"), action("return", "primary")];
      if (pr.merged === null && pr.closedAt !== null)
        return [action("open-pr"), action("close"), action("return", "primary")];
      return [action("open-pr"), action("return"), action("accept", "primary")];
    }
    case "accepted":
      return send?.pullRequest ? [action("open-pr")] : [];
    case "done":
    case "closed":
      return [action("reopen")];
  }
}

/** The permission bundle an action takes (@oxagen/work/records authorize.ts), or null for a link. */
function actionRole(name: HeadActionName): "control" | "approve" | null {
  switch (name) {
    case "approve":
    case "accept":
      return "approve";
    case "open-run":
    case "open-pr":
      return null;
    default:
      return "control";
  }
}

/** Why an action is held back, as a code the page words. */
export type ActionBlock =
  | { kind: "control" }
  | { kind: "approve" }
  | { kind: "gate"; block: ReviewBlock | null; detail: string | null }
  | { kind: "targets" }
  | { kind: "noApprovedBrief" }
  | { kind: "noSendKey" }
  | { kind: "needsRepository" };

/** The gate on the newest send as the page reads it: closed with no head when the head is unread. */
export function acceptBlock(send: WorkSend | null): ActionBlock | null {
  if (send === null) return { kind: "gate", block: "no_pull_request", detail: null };
  if (!send.gate.open) {
    return { kind: "gate", block: send.gate.block, detail: send.gate.detail };
  }
  if (send.pullRequest === null || send.pullRequest.head === null) {
    return { kind: "gate", block: "no_head", detail: null };
  }
  return null;
}

/**
 * Why the viewer cannot take an action now, or null when they can. The
 * viewer's roles come first, from the same check each action makes. The
 * record comes next, so a refusal on the server is rare.
 */
export function actionBlock(
  name: HeadActionName,
  detail: ItemData,
  targetsRead: boolean,
): ActionBlock | null {
  const role = actionRole(name);
  if (role === "control" && !detail.viewer.canControl) return { kind: "control" };
  if (role === "approve" && !detail.viewer.canApprove) return { kind: "approve" };
  switch (name) {
    case "approve": {
      const plan = approvePlan(detail);
      if (plan.kind === "needs-repository") return { kind: "needsRepository" };
      // Saving the brief first takes the control bundle too.
      if (plan.kind === "save-and-approve" && !detail.viewer.canControl)
        return { kind: "control" };
      return null;
    }
    case "accept":
      return acceptBlock(latestSend(detail));
    case "send":
      if (!targetsRead) return { kind: "targets" };
      if (approvedBrief(detail) === null) return { kind: "noApprovedBrief" };
      if (detail.nextSend === null) return { kind: "noSendKey" };
      return null;
    default:
      return null;
  }
}

/** True when the Send dialog may open: Send is on offer and nothing holds it back. */
export function canOpenSend(detail: ItemData, targetsRead: boolean): boolean {
  return (
    headActions(detail).some((a) => a.name === "send") &&
    actionBlock("send", detail, targetsRead) === null
  );
}

/** The send the Review panel reads: the newest, once its run ended or it has a pull request. */
export function reviewSend(detail: Pick<ItemData, "sends">): WorkSend | null {
  const send = latestSend(detail);
  if (send === null) return null;
  return send.runEndedAt !== null || send.pullRequest !== null ? send : null;
}

/** The word a send's status reads. A send the host polled and has not claimed reads No answer. */
export type DeliveryWord = DeliveryState | "no_answer";

export function deliveryWord(send: WorkSend): DeliveryWord {
  return send.delivery === "waiting_for_claim" && send.noAnswer
    ? "no_answer"
    : send.delivery;
}

/** A send that is still out: its key is the one a retry reuses. */
export function sendLive(send: WorkSend): boolean {
  return (
    send.delivery === "waiting_for_claim" ||
    send.delivery === "claimed" ||
    send.delivery === "running" ||
    send.delivery === "stopping"
  );
}

/** Whether the gateway holds the agent's budget before each model call at this tier. */
export function budgetHeld(tier: RuntimeTier): boolean {
  return tier === "gateway" || tier === "contained";
}

/** The digest as a person reads it: twelve hex characters after `sha256:`. */
export function shortDigest(digest: string): string {
  return digest.startsWith("sha256:") ? digest.slice(7, 19) : digest.slice(0, 12);
}

/** A required check on the head, with what it reported or that it has not reported. */
export type RequiredCheck = {
  name: string;
  conclusion: CheckConclusion | "not_reported";
};

/** The required checks, one row each, or null when oxagen has not read which are required. */
export function requiredChecks(send: WorkSend): RequiredCheck[] | null {
  if (send.requiredChecks === null) return null;
  return send.requiredChecks.map((name) => ({
    name,
    conclusion: send.checks.find((c) => c.name === name)?.conclusion ?? "not_reported",
  }));
}

/** The checks no rule requires: shown for reference, ignored by acceptance. */
export function optionalChecks(send: WorkSend): WorkCheck[] {
  const required = send.requiredChecks ?? [];
  return send.checks.filter((c) => !c.required && !required.includes(c.name));
}

/** The kinds of history entry the page has a sentence for (ADR-244 facts). */
const HISTORY_KINDS = [
  "collected",
  "entered",
  "source_changed",
  "triage_recorded",
  "triage_failed",
  "triage_overridden",
  "brief_saved",
  "brief_approved",
  "send_requested",
  "send_delivered",
  "send_rejected",
  "send_withdrawn",
  "claimed",
  "run_linked",
  "run_ended",
  "stop_requested",
  "stopped",
  "pr_linked",
  "head_observed",
  "checks_required",
  "check_observed",
  "criterion_claimed",
  "returned",
  "accepted",
  "merged",
  "pr_closed",
  "closed",
  "reopened",
] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

export function isHistoryKind(kind: string): kind is HistoryKind {
  return HISTORY_KINDS.some((known) => known === kind);
}
