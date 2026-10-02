// reduce.ts: a work item's state, read from its facts.
//
// reduceWorkItem is a pure function of the fact set. It sorts the facts into
// the canonical order first (facts.ts compareFacts), and each rule below reads
// either the presence of a kind or a binding the fact carries (a revision, a
// send, a head commit), never the order in which facts arrived. So a late
// webhook, a retried delivery, or a merge seen before review all reduce to the
// same state as the same facts in any other order.
//
// The Phase 1 rules (agent-work-phase-1.html, Work lifecycle):
//   - An agent stopping is not acceptance. A claim is the agent's word and
//     moves nothing.
//   - An acceptance counts only for the head commit it names. A newer head
//     voids it, and an older head's late results stay on that head.
//   - Done means accepted and merged, in either order. A pull request closed
//     without merging is not done.
//   - A material source or brief change after approval leaves the item
//     changed. A running order keeps the brief it was sent with.
//   - Reopening keeps every earlier fact and starts a fresh delivery on a new
//     revision.
import type { Sha256Digest } from "@oxagen/run-evidence";
import {
  type CheckConclusion,
  type CloseResolution,
  type FactOf,
  type RuntimeTier,
  type TriageOutcome,
  type WorkFact,
  sortFacts,
} from "./facts";

/** Where a work item stands. Provider status, run status, and review state are separate fields. */
export const WORK_ITEM_STATES = [
  "new",
  "held",
  "triaged",
  "needs_info",
  "changed",
  "ready",
  "sent",
  "running",
  "review",
  "done",
  "closed",
] as const;
export type WorkItemState = (typeof WORK_ITEM_STATES)[number];

/** Where one send stands with its runtime. */
export const DELIVERY_STATES = [
  "waiting_for_claim",
  "claimed",
  "running",
  "stopping",
  "run_ended",
  "stopped",
  "returned",
  "withdrawn",
  "rejected",
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/** The delivery states that end a send. */
export const TERMINAL_DELIVERY_STATES: readonly DeliveryState[] = ["stopped", "returned", "withdrawn", "rejected"];

/** Why a person cannot accept a send's result yet. */
export const REVIEW_BLOCKS = [
  "order_closed",
  "already_accepted",
  "run_active",
  "pr_closed",
  "no_pull_request",
  "no_head",
  "brief_out_of_date",
  "checks_unknown",
  "check_missing",
  "check_failed",
] as const;
export type ReviewBlock = (typeof REVIEW_BLOCKS)[number];

/** Whether Accept is open on a send, and if not, why. */
export type ReviewGate =
  | { open: true; requiredChecks: string[] }
  | { open: false; block: ReviewBlock; detail: string | null };

/** What changed to make the current revision. */
export type RevisionCause = "source" | "brief" | "reopen";

/** One brief revision. */
export interface BriefRef {
  briefId: string;
  revision: number;
  digest: Sha256Digest;
  itemRevision: number;
}

/** A brief revision and the person who approved it. */
export interface ApprovalRef extends BriefRef {
  actor: string;
  at: string;
}

/** A person's acceptance of one head commit. */
export interface AcceptanceRef {
  headSha: string;
  briefDigest: Sha256Digest;
  criteria: string[];
  requiredChecks: string[];
  actor: string;
  at: string;
}

/** A check's latest conclusion on the head commit. */
export interface CheckRef {
  name: string;
  conclusion: CheckConclusion;
  required: boolean;
}

/** An agent's latest claim on one criterion. */
export interface ClaimRef {
  criterionId: string;
  text: string;
  headSha: string | null;
  /** True when the claim names the current head commit. */
  current: boolean;
}

/** One send, as its facts describe it. */
export interface OrderProjection {
  orderId: string;
  send: number;
  key: string;
  briefId: string;
  briefRevision: number;
  briefDigest: Sha256Digest;
  /** The item revision the send went out on. */
  itemRevision: number;
  agentId: string;
  runtimeId: string;
  runtimeTier: RuntimeTier;
  operatorId: string;
  requestedAt: string;
  delivery: DeliveryState;
  runIds: string[];
  pullRequest: { repository: string; number: number } | null;
  /** The pull request's head commit: the merged head once it merged. */
  head: string | null;
  /** The checks the base branch requires on the head. Null until Oxagen reads them for this head. */
  requiredChecks: string[] | null;
  checks: CheckRef[];
  claims: ClaimRef[];
  /** The acceptance that names the current head. */
  acceptance: AcceptanceRef | null;
  /** The latest acceptance on an older head. It counts for nothing and stays visible. */
  staleAcceptance: AcceptanceRef | null;
  merge: { headSha: string; mergeCommit: string; at: string } | null;
  /** The pull request closed without merging. */
  prClosed: boolean;
  returned: { reason: string; actor: string; at: string } | null;
  done: boolean;
  /** The agent's capacity is free again: the run ended or the send is over. */
  released: boolean;
  /** The send is over. Another send may start. */
  closed: boolean;
}

/** A work item, as its facts describe it. */
export interface WorkItemProjection {
  state: WorkItemState;
  /** The item revision. It moves on a material source change, a brief change after approval, and a reopen. */
  revision: number;
  revisionCause: RevisionCause | null;
  /** The latest source snapshot. */
  source: { revision: number; digest: Sha256Digest; at: string } | null;
  triage: {
    outcome: TriageOutcome | "failed" | null;
    by: "oxagen" | "person" | null;
    decision: string | null;
    duplicateOf: string | null;
  };
  latestBrief: BriefRef | null;
  /** The approval for the current revision. Null when none holds. */
  approvedBrief: ApprovalRef | null;
  /** The latest approval on any revision. */
  lastApproval: ApprovalRef | null;
  /** Every send, oldest first. */
  orders: OrderProjection[];
  /** The send that is not over, if any. */
  activeOrder: OrderProjection | null;
  closure: { resolution: CloseResolution; reason: string; actor: string; at: string } | null;
  /** Sends up to this number belong to the item's life before its latest reopen. */
  reopenedAfterSend: number;
  /** The active send went out on an earlier revision than the current one. */
  changedSinceSend: boolean;
  /** The next send number. */
  nextSend: number;
}

function last<T>(list: readonly T[]): T | undefined {
  return list[list.length - 1];
}

function ofKind<K extends WorkFact["kind"]>(facts: readonly WorkFact[], kind: K): FactOf<K>[] {
  return facts.filter((fact) => fact.kind === kind) as unknown as FactOf<K>[];
}

function ofKinds(facts: readonly WorkFact[], kinds: readonly WorkFact["kind"][]): WorkFact[] {
  return facts.filter((fact) => kinds.includes(fact.kind));
}

function deliveryOf(facts: readonly WorkFact[]): DeliveryState {
  const has = (kind: WorkFact["kind"]) => facts.some((fact) => fact.kind === kind);
  // Each rule reads presence, so arrival order cannot change the answer. A
  // fact that ends the send outranks every other, so a send once ended stays
  // ended: the store marks the order closed for good, and the database's
  // one-open-send rules depend on that. The store refuses a runtime's claim on
  // an ended send, so the runtime never starts it.
  if (has("stopped")) return "stopped";
  if (has("returned")) return "returned";
  if (has("send_withdrawn")) return "withdrawn";
  if (has("send_rejected")) return "rejected";
  if (has("run_ended")) return "run_ended";
  if (has("stop_requested") && (has("claimed") || has("run_linked"))) return "stopping";
  if (has("run_linked")) return "running";
  if (has("claimed")) return "claimed";
  return "waiting_for_claim";
}

function acceptanceOf(fact: FactOf<"accepted">): AcceptanceRef {
  return {
    headSha: fact.headSha as string,
    briefDigest: fact.briefDigest as Sha256Digest,
    criteria: [...fact.data.criteria],
    requiredChecks: [...fact.data.required_checks],
    actor: fact.actor,
    at: fact.occurredAt,
  };
}

function reduceOrder(
  request: FactOf<"send_requested">,
  facts: readonly WorkFact[],
  closedRevisions: readonly number[],
): OrderProjection {
  const delivery = deliveryOf(facts);
  // The send's pull request is the last one its run linked (or, with no link,
  // the last one a head was observed on). A run can close one pull request and
  // open another, so the head, the merge, and a close count only for that one.
  // A fact that names no pull request counts for whichever is current.
  const prFact = last(ofKind(facts, "pr_linked")) ?? last(ofKind(facts, "head_observed"));
  const pullRequest =
    prFact && prFact.repository !== null && prFact.prNumber !== null
      ? { repository: prFact.repository, number: prFact.prNumber }
      : null;
  const onPullRequest = (fact: WorkFact): boolean =>
    pullRequest === null ||
    fact.repository === null ||
    fact.prNumber === null ||
    (fact.repository.toLowerCase() === pullRequest.repository.toLowerCase() && fact.prNumber === pullRequest.number);
  // A pull request merges once. The first merge fact fixes the merged head, so
  // a done send stays done whatever arrives after it.
  const mergeFact = ofKind(facts, "merged").filter(onPullRequest)[0];
  const merge = mergeFact
    ? { headSha: mergeFact.headSha as string, mergeCommit: mergeFact.data.merge_commit, at: mergeFact.occurredAt }
    : null;
  const headFact = last(ofKind(facts, "head_observed").filter(onPullRequest));
  const head = merge?.headSha ?? headFact?.headSha ?? null;

  const requiredFact = head === null ? undefined : last(ofKind(facts, "checks_required").filter((f) => f.headSha === head));
  const requiredChecks = requiredFact ? [...new Set(requiredFact.data.names)].sort() : null;
  const latestCheck = new Map<string, CheckConclusion>();
  for (const fact of ofKind(facts, "check_observed")) {
    if (fact.headSha === head) latestCheck.set(fact.data.name, fact.data.conclusion);
  }
  const checks = [...latestCheck.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, conclusion]) => ({ name, conclusion, required: requiredChecks?.includes(name) ?? false }));

  const latestClaim = new Map<string, FactOf<"criterion_claimed">>();
  for (const fact of ofKind(facts, "criterion_claimed")) latestClaim.set(fact.criterionId as string, fact);
  const claims = [...latestClaim.values()]
    .sort((a, b) => ((a.criterionId as string) < (b.criterionId as string) ? -1 : 1))
    .map((fact) => ({
      criterionId: fact.criterionId as string,
      text: fact.data.text,
      headSha: fact.headSha,
      current: fact.headSha !== null && fact.headSha === head,
    }));

  const accepted = ofKind(facts, "accepted");
  const onHead = last(accepted.filter((fact) => fact.headSha === head));
  const offHead = last(accepted.filter((fact) => fact.headSha !== head));
  const acceptance = head !== null && onHead ? acceptanceOf(onHead) : null;
  const staleAcceptance = offHead ? acceptanceOf(offHead) : null;

  const prClosed = merge === null && facts.some((fact) => fact.kind === "pr_closed" && onPullRequest(fact));
  const returnFact = last(ofKind(facts, "returned"));
  const returned = returnFact ? { reason: returnFact.data.reason, actor: returnFact.actor, at: returnFact.occurredAt } : null;
  const done = acceptance !== null && merge !== null;
  // A close recorded on the order's revision or a later one ends the order.
  // A reopen moves the revision, so a send after the reopen is not ended by
  // the close before it.
  const closedByItem = closedRevisions.some((revision) => revision >= request.itemRevision);
  const closed = TERMINAL_DELIVERY_STATES.includes(delivery) || done || closedByItem;
  const released = closed || delivery === "run_ended" || merge !== null;

  const runIds: string[] = [];
  for (const fact of ofKinds(facts, ["run_linked", "run_ended"])) {
    if (fact.runId !== null && !runIds.includes(fact.runId)) runIds.push(fact.runId);
  }

  return {
    orderId: request.orderId as string,
    send: request.data.send,
    key: request.data.key,
    briefId: request.briefId as string,
    briefRevision: request.data.brief_revision,
    briefDigest: request.briefDigest as Sha256Digest,
    itemRevision: request.itemRevision,
    agentId: request.data.agent_id,
    runtimeId: request.data.runtime_id,
    runtimeTier: request.data.runtime_tier,
    operatorId: request.data.operator_id,
    requestedAt: request.occurredAt,
    delivery,
    runIds,
    pullRequest,
    head,
    requiredChecks,
    checks,
    claims,
    acceptance,
    staleAcceptance,
    merge,
    prClosed,
    returned,
    done,
    released,
    closed,
  };
}

function briefRef(fact: FactOf<"brief_saved"> | FactOf<"brief_approved">): BriefRef {
  return {
    briefId: fact.briefId as string,
    revision: fact.data.revision,
    digest: fact.briefDigest as Sha256Digest,
    itemRevision: fact.itemRevision,
  };
}

/**
 * Whether a person may accept the result of one send now, and if not, why.
 * The gate fails closed: a required check that is missing, failing,
 * cancelled, or skipped blocks, and so does a head whose required checks
 * nobody has read. When the base branch requires no check, the gate opens and
 * acceptance rests on the person's tick for every criterion, which the
 * acceptance records with the head commit (oxagen-roadmap#279).
 */
export function reviewGate(item: Pick<WorkItemProjection, "approvedBrief">, order: OrderProjection): ReviewGate {
  if (order.closed) return { open: false, block: "order_closed", detail: null };
  if (order.acceptance !== null) return { open: false, block: "already_accepted", detail: order.acceptance.headSha };
  if (order.merge === null && order.delivery !== "run_ended") return { open: false, block: "run_active", detail: order.delivery };
  if (order.prClosed) return { open: false, block: "pr_closed", detail: null };
  if (order.pullRequest === null) return { open: false, block: "no_pull_request", detail: null };
  if (order.head === null) return { open: false, block: "no_head", detail: null };
  if (item.approvedBrief === null) return { open: false, block: "brief_out_of_date", detail: null };
  if (order.requiredChecks === null) return { open: false, block: "checks_unknown", detail: order.head };
  for (const name of order.requiredChecks) {
    const check = order.checks.find((entry) => entry.name === name);
    if (check === undefined) return { open: false, block: "check_missing", detail: name };
    if (check.conclusion !== "success") return { open: false, block: "check_failed", detail: `${name}: ${check.conclusion}` };
  }
  return { open: true, requiredChecks: [...order.requiredChecks] };
}

/** Reduce a work item's facts to its state. Pure, and independent of the facts' order. */
export function reduceWorkItem(input: readonly WorkFact[]): WorkItemProjection {
  const facts = sortFacts(input);
  const revision = facts.reduce((highest, fact) => Math.max(highest, fact.itemRevision), 1);

  let revisionCause: RevisionCause | null = null;
  if (revision > 1) {
    const atRevision = facts.filter((fact) => fact.itemRevision === revision);
    if (atRevision.some((fact) => fact.kind === "reopened")) revisionCause = "reopen";
    else if (atRevision.some((fact) => fact.kind === "source_changed")) revisionCause = "source";
    else if (atRevision.some((fact) => fact.kind === "brief_saved" && fact.data.revises)) revisionCause = "brief";
  }

  const sourceFact = last(ofKinds(facts, ["collected", "entered", "source_changed"]));
  const source =
    sourceFact && (sourceFact.kind === "collected" || sourceFact.kind === "entered" || sourceFact.kind === "source_changed")
      ? { revision: sourceFact.itemRevision, digest: sourceFact.data.digest, at: sourceFact.occurredAt }
      : null;

  // A person's triage override holds until a person clears it (a null
  // outcome). Without one, the latest triage result or failure decides.
  const override = last(ofKind(facts, "triage_overridden"));
  const suggestion = last(ofKinds(facts, ["triage_recorded", "triage_failed"]));
  let triage: WorkItemProjection["triage"] = { outcome: null, by: null, decision: null, duplicateOf: null };
  if (override && override.data.outcome !== null) {
    triage = { outcome: override.data.outcome, by: "person", decision: null, duplicateOf: override.data.duplicate_of };
  } else if (suggestion?.kind === "triage_recorded") {
    triage = {
      outcome: suggestion.data.outcome,
      by: "oxagen",
      decision: suggestion.data.decision,
      duplicateOf: suggestion.data.duplicate_of,
    };
  } else if (suggestion?.kind === "triage_failed") {
    triage = { outcome: "failed", by: "oxagen", decision: null, duplicateOf: null };
  }

  const saved = ofKind(facts, "brief_saved");
  let latestBrief: BriefRef | null = null;
  for (const fact of saved) {
    if (latestBrief === null || fact.data.revision > latestBrief.revision) latestBrief = briefRef(fact);
  }
  const approvals = ofKind(facts, "brief_approved").map((fact) => ({
    ...briefRef(fact),
    actor: fact.actor,
    at: fact.occurredAt,
  }));
  const approvedBrief = last(approvals.filter((approval) => approval.itemRevision === revision)) ?? null;
  const lastApproval = last(approvals) ?? null;

  const closeFacts = ofKinds(facts, ["closed", "reopened"]);
  const closeFact = last(closeFacts);
  const closure =
    closeFact?.kind === "closed"
      ? { resolution: closeFact.data.resolution, reason: closeFact.data.reason, actor: closeFact.actor, at: closeFact.occurredAt }
      : null;
  const reopen = last(ofKind(facts, "reopened"));
  const reopenedAfterSend = reopen ? reopen.data.after_send : 0;
  const closedRevisions = ofKind(facts, "closed").map((fact) => fact.itemRevision);

  const byOrder = new Map<string, WorkFact[]>();
  for (const fact of facts) {
    if (fact.orderId === null) continue;
    const list = byOrder.get(fact.orderId);
    if (list) list.push(fact);
    else byOrder.set(fact.orderId, [fact]);
  }
  const orders: OrderProjection[] = [];
  for (const orderFacts of byOrder.values()) {
    // An order is known by its send request. The store writes the request
    // with the order row, so a fact for any other order is not this item's.
    const request = ofKind(orderFacts, "send_requested")[0];
    if (request) orders.push(reduceOrder(request, orderFacts, closedRevisions));
  }
  orders.sort((a, b) => a.send - b.send);
  const activeOrder = last(orders.filter((order) => !order.closed)) ?? null;
  const nextSend = (last(orders)?.send ?? 0) + 1;
  const latestInCycle = last(orders.filter((order) => order.send > reopenedAfterSend));

  let state: WorkItemState;
  if (closure !== null) {
    state = "closed";
  } else if (latestInCycle?.done) {
    state = "done";
  } else if (activeOrder !== null) {
    if (activeOrder.merge !== null || activeOrder.prClosed || activeOrder.delivery === "run_ended") state = "review";
    else if (activeOrder.delivery === "waiting_for_claim") state = "sent";
    else state = "running";
  } else if (approvedBrief !== null) {
    state = "ready";
  } else if (lastApproval !== null && (revisionCause === "source" || revisionCause === "brief")) {
    state = "changed";
  } else if (triage.outcome === "duplicate" || triage.outcome === "out_of_scope") {
    state = "held";
  } else if (triage.outcome === "needs_info") {
    state = "needs_info";
  } else if (triage.outcome === "triaged" || latestBrief !== null) {
    state = "triaged";
  } else {
    state = "new";
  }

  return {
    state,
    revision,
    revisionCause,
    source,
    triage,
    latestBrief,
    approvedBrief,
    lastApproval,
    orders,
    activeOrder,
    closure,
    reopenedAfterSend,
    changedSinceSend: activeOrder !== null && activeOrder.itemRevision < revision,
    nextSend,
  };
}
