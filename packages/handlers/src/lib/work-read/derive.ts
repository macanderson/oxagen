// derive.ts: the fields the Work pages draw, decided from a work item's facts
// (P1-05, #5163; agent-work-phase-1.html, Screens).
//
// Every function here is pure. It reads the item's projection
// (reduceWorkItem in @oxagen/work/records), its facts, the triage view with
// every correction in force (effectiveTriage in @oxagen/work), and the rows
// the read resolved beside them: display names, agents, runtimes, the host and
// command of each send, and what each run cost. read.ts gathers those rows,
// and these functions turn them into the contract's shapes:
//
//   - tab: the Work page tab the item sits on.
//   - status: the word beside the item's dot. It refines the state with the
//     facts around it: a new item is triaging until triage fails, a held item
//     is a possible duplicate or out of scope, a sent item reads no answer once
//     its host took the command and has not claimed it, and an item in review
//     reads accepted once a person accepted its head commit, unless the Oxagen
//     GitHub App merged it.
//   - wait: what the item waits for, as one code and the facts to say it.
//   - send: the latest send since the last reopen, with the required checks on
//     its pull request's head as one word and whether Accept is open. The
//     facts name the pull request acceptance is judged on. The forge store
//     (ADR-292) names every pull request the send has and the state of each.
//   - cost: what the item's runs cost, with how many of them have a known cost.
//     A run with no recorded cost stays unknown. Nothing here invents a zero.
//
// Nothing here calls GitHub. The checks are what Oxagen last recorded.
import type { WorkItemRowOutput, WorkWaitOutput } from "@oxagen/oxagen/contracts/work.read.shared";
import type { TriageView } from "@oxagen/work";
import {
  type CheckConclusion,
  type FactKind,
  type FactOf,
  type OrderProjection,
  type WorkFact,
  type WorkItemProjection,
  type WorkItemState,
  appMergerOf,
  reviewGate,
  sortFacts,
} from "@oxagen/work/records";
import type { OrderPullRequest } from "../forge-pull-requests/orders";

export type WorkTab = WorkItemRowOutput["tab"];
export type WorkStatus = WorkItemRowOutput["status"];
export type WorkSendSummary = NonNullable<WorkItemRowOutput["send"]>;
export type WorkChecksWord = WorkSendSummary["checks"];
export type WorkGate = WorkSendSummary["gate"];
export type WorkCost = WorkItemRowOutput["cost"];
export type WorkPriorityView = WorkItemRowOutput["priority"];

/** A run's cost as the spend rollup recorded it (cost.run_totals). */
export interface RunCost {
  /** Null when the run reported no usage the rollup could price. */
  costMicros: bigint | null;
  currency: string;
  /** How the cost was measured (`cost_basis`). */
  basis: string | null;
  /** Where the budget was enforced (`enforcement_tier`). */
  tier: string | null;
}

/** One send's row beside its facts: its public id, its mandate, and its command. */
export interface OrderRowRef {
  /** The work order's public id (`wo_…`). */
  publicId: string;
  /** The agent's mandate at send, as its public id (`mnd_…`), or null. */
  mandateId: string | null;
  /** The host the send's `work_order` command went to, or null when none is recorded. */
  host: { name: string; lastPollAt: string | null } | null;
  /** The outcome of the send's `work_order` command, or null when it has none. */
  commandOutcome: string | null;
}

/** The rows a read resolved beside the facts, keyed for the derivations. */
export interface Lookups {
  /** A person's display name by user id. Absent or null when Oxagen holds no name. */
  names: ReadonlyMap<string, string | null>;
  /** Work items by public id, for a possible duplicate. */
  items: ReadonlyMap<string, { id: string; number: string }>;
  /** Agents by row id. */
  agents: ReadonlyMap<string, { publicId: string; name: string; harness: string }>;
  /** Runtimes by row id. */
  runtimes: ReadonlyMap<string, { publicId: string; name: string }>;
  /** Work orders by row id. */
  orders: ReadonlyMap<string, OrderRowRef>;
  /** Run costs by run id (`arun_…` or `tse_…`). */
  runs: ReadonlyMap<string, RunCost>;
  /**
   * Every pull request each send has in the forge store, newest first, by
   * work order row id (ADR-292). A send with none is absent.
   */
  pullRequests: ReadonlyMap<string, readonly OrderPullRequest[]>;
}

/** The work.items columns a row shows. */
export interface ItemColumns {
  publicId: string;
  number: string;
  /** The source's subject. */
  title: string;
  origin: WorkItemRowOutput["origin"];
  sourceUrl: string | null;
  /** The repository the item came from, as owner/name. */
  repository: string | null;
  requester: string | null;
  labels: string[];
  /** When the row was created, as an ISO 8601 time. */
  arrivedAt: string;
  version: number;
}

/** One item, as the derivations read it. */
export interface DerivedItem {
  columns: ItemColumns;
  /**
   * The item's facts, in any order: the derivations sort them. The list
   * leaves out the check facts on a send's older head commits
   * (listFactsByItem in read.ts). Nothing here reads a check fact, only the
   * projection's checks on the current head.
   */
  facts: readonly WorkFact[];
  projection: WorkItemProjection;
  /** The triage suggestion with every correction in force. */
  triage: TriageView;
}

const TABS: Readonly<Record<WorkItemState, WorkTab>> = {
  new: "inbox",
  held: "inbox",
  triaged: "inbox",
  needs_info: "inbox",
  changed: "inbox",
  ready: "inbox",
  sent: "running",
  running: "running",
  review: "review",
  done: "done",
  closed: "done",
};

/** The Work page tab an item in this state sits on. Pure. */
export function tabOf(state: WorkItemState): WorkTab {
  return TABS[state];
}

function last<T>(list: readonly T[]): T | undefined {
  return list[list.length - 1];
}

function ofKind<K extends FactKind>(facts: readonly WorkFact[], kind: K): FactOf<K>[] {
  return facts.filter((fact) => fact.kind === kind) as unknown as FactOf<K>[];
}

/** The facts of one send, in the order given. Pure. */
export function factsOfOrder(facts: readonly WorkFact[], orderId: string): WorkFact[] {
  return facts.filter((fact) => fact.orderId === orderId);
}

/** The display name of a user id, or null. Pure. */
export function nameOf(lookups: Pick<Lookups, "names">, userId: string | null | undefined): string | null {
  if (userId === null || userId === undefined) return null;
  return lookups.names.get(userId) ?? null;
}

/** The latest send since the last reopen, or null. Pure. */
export function latestInCycle(projection: WorkItemProjection): OrderProjection | null {
  return last(projection.orders.filter((order) => order.send > projection.reopenedAfterSend)) ?? null;
}

/** The latest done send since the last reopen, or null. Pure. */
export function latestDoneInCycle(projection: WorkItemProjection): OrderProjection | null {
  return last(projection.orders.filter((order) => order.send > projection.reopenedAfterSend && order.done)) ?? null;
}

/** When a send was done: the later of its acceptance and its merge. Null when it is not done. Pure. */
export function doneAtOf(order: OrderProjection): string | null {
  if (!order.done || order.acceptance === null || order.merge === null) return null;
  return Date.parse(order.acceptance.at) >= Date.parse(order.merge.at) ? order.acceptance.at : order.merge.at;
}

/**
 * Whether a send's host took its `work_order` command and has not claimed it.
 * The send is still waiting for its claim, and either a `send_delivered` fact
 * records that the host took the command, or the command row says it left
 * (`sent`) or the host received it (`received`). Pure.
 */
export function noAnswerOf(order: OrderProjection, orderFacts: readonly WorkFact[], commandOutcome: string | null): boolean {
  if (order.delivery !== "waiting_for_claim") return false;
  if (orderFacts.some((fact) => fact.kind === "send_delivered")) return true;
  return commandOutcome === "sent" || commandOutcome === "received";
}

/** Whether the item's active send has no answer, from the facts and its command row. Pure. */
export function activeNoAnswer(item: Pick<DerivedItem, "facts" | "projection">, lookups: Pick<Lookups, "orders">): boolean {
  const active = item.projection.activeOrder;
  if (active === null) return false;
  return noAnswerOf(active, factsOfOrder(item.facts, active.orderId), lookups.orders.get(active.orderId)?.commandOutcome ?? null);
}

/**
 * The word beside the item's dot. `noAnswer` is whether the active send's
 * host took its command and has not claimed it (noAnswerOf). Pure.
 */
export function statusOf(projection: WorkItemProjection, noAnswer: boolean): WorkStatus {
  const active = projection.activeOrder;
  switch (projection.state) {
    case "closed":
      return "closed";
    case "done":
      return "done";
    case "new":
      return projection.triage.outcome === "failed" ? "triage_failed" : "triaging";
    case "held":
      return projection.triage.outcome === "duplicate" ? "possible_duplicate" : "out_of_scope";
    case "needs_info":
      return "needs_info";
    case "triaged":
      return "brief_to_approve";
    case "changed":
      return "changed";
    case "ready":
      return latestInCycle(projection)?.delivery === "rejected" ? "send_rejected" : "ready";
    case "sent":
      return active?.delivery === "waiting_for_claim" && noAnswer ? "no_answer" : "waiting_for_claim";
    case "running":
      return active?.delivery === "stopping" ? "stopping" : "running";
    case "review":
      // An accepted send whose pull request then closed unmerged is back in
      // review: the acceptance stands on its head, but nothing will merge. So
      // is one the Oxagen GitHub App merged: the merge stands, and it is not
      // a person's, so a person returns the work or closes the item.
      return active?.acceptance && !active.prClosed && appMergerOf(active) === null ? "accepted" : "in_review";
  }
}

/** A required check that holds a send's head, and why. */
type RequiredCheckHold =
  | { kind: "failed"; name: string; conclusion: CheckConclusion }
  | { kind: "missing"; name: string }
  | { kind: "running"; name: string };

/**
 * The required check that holds a send's head, ranked the way a person reads
 * them: one that finished without passing, then one that has not reported,
 * then one still running. Within a rank, the first by name. Null when every
 * required check passed. The checks word and the wait line both read this, so
 * they cannot name different checks (#5181). Pure.
 */
function requiredCheckHoldOf(order: OrderProjection): RequiredCheckHold | null {
  const required = (order.requiredChecks ?? []).map((name) => ({
    name,
    conclusion: order.checks.find((check) => check.name === name)?.conclusion,
  }));
  for (const { name, conclusion } of required) {
    if (conclusion !== undefined && conclusion !== "success" && conclusion !== "pending") return { kind: "failed", name, conclusion };
  }
  const missing = required.find((check) => check.conclusion === undefined);
  if (missing !== undefined) return { kind: "missing", name: missing.name };
  const running = required.find((check) => check.conclusion === "pending");
  if (running !== undefined) return { kind: "running", name: running.name };
  return null;
}

/**
 * The required checks on a send's head, as one word. A failure outranks a
 * check that has not reported, which outranks one still running. Pure.
 */
export function checksWordOf(order: OrderProjection): WorkChecksWord {
  if (order.pullRequest === null) return "no_pull_request";
  if (order.prClosed) return "pr_closed";
  if (order.requiredChecks === null) return "unread";
  if (order.requiredChecks.length === 0) return "none_required";
  const hold = requiredCheckHoldOf(order);
  if (hold === null) return "passing";
  return hold.kind === "failed" ? "failing" : hold.kind;
}

/** Whether Accept is open on a send, and if not, why (reviewGate). Pure. */
export function gateOf(projection: Pick<WorkItemProjection, "approvedBrief">, order: OrderProjection): WorkGate {
  const gate = reviewGate(projection, order);
  if (gate.open) return { open: true, block: null, detail: null };
  return { open: false, block: gate.block, detail: gate.detail };
}

/**
 * What a set of runs cost. `runs` counts each run once, `known_runs` counts
 * the runs whose cost the rollup recorded, and `total` sums those. The total
 * is null when no cost is known or when the known costs are in different
 * currencies, never a zero in place of an unknown. Pure.
 */
export function costOf(runIds: Iterable<string>, runs: ReadonlyMap<string, RunCost>): WorkCost {
  const unique = [...new Set(runIds)];
  let known = 0;
  let total = 0n;
  let currency: string | null = null;
  let mixed = false;
  for (const runId of unique) {
    const run = runs.get(runId);
    if (run === undefined || run.costMicros === null) continue;
    known += 1;
    total += run.costMicros;
    if (currency === null) currency = run.currency;
    else if (currency !== run.currency) mixed = true;
  }
  return {
    runs: unique.length,
    known_runs: known,
    total: known === 0 || mixed || currency === null ? null : { micros: total.toString(), currency },
  };
}

/** Every run linked to any of the item's sends, each once. Pure. */
export function itemRunIds(projection: Pick<WorkItemProjection, "orders">): string[] {
  return [...new Set(projection.orders.flatMap((order) => order.runIds))];
}

/** The priority a person sees: triage's suggestion or a person's correction. Pure. */
export function priorityViewOf(triage: TriageView, lookups: Pick<Lookups, "names">): WorkPriorityView {
  return {
    label: triage.priority.value,
    by: triage.priority.by,
    reason: triage.priorityReason,
    cites: [...triage.cites],
    set_by: triage.priority.by === "person" ? nameOf(lookups, triage.priority.actor) : null,
  };
}

/** The fact kinds that move an item to its next revision. */
function movesRevision(fact: WorkFact): boolean {
  return fact.kind === "source_changed" || fact.kind === "reopened" || (fact.kind === "brief_saved" && fact.data.revises);
}

/**
 * When the item moved to its current revision because of `cause`: the time of
 * the source change, or of the brief edit after approval. Null when no such
 * fact is at the current revision. `facts` are sorted.
 */
function revisionMovedAt(facts: readonly WorkFact[], revision: number, cause: "source" | "brief"): string | null {
  const mover = facts.find(
    (fact) =>
      fact.itemRevision === revision &&
      (cause === "source" ? fact.kind === "source_changed" : fact.kind === "brief_saved" && fact.data.revises),
  );
  return mover?.occurredAt ?? null;
}

/** The reopen behind the current revision, or null when the revision did not come from a reopen. */
function reopenedOf(item: Pick<DerivedItem, "projection">, facts: readonly WorkFact[], lookups: Pick<Lookups, "names">) {
  if (item.projection.revisionCause !== "reopen") return null;
  const reopen = last(ofKind(facts, "reopened"));
  if (reopen === undefined) return null;
  return { by: nameOf(lookups, reopen.actor), at: reopen.occurredAt, reason: reopen.data.reason };
}

/** The runtime's name for a send, or null when the row is gone. */
function runtimeNameOf(order: OrderProjection, lookups: Pick<Lookups, "runtimes">): string | null {
  return lookups.runtimes.get(order.runtimeId)?.name ?? null;
}

/** When the host the send went to last polled, or null. */
function lastPollOf(order: OrderProjection, lookups: Pick<Lookups, "orders">): string | null {
  return lookups.orders.get(order.orderId)?.host?.lastPollAt ?? null;
}

/** How a send that came back to ready ended: withdrawn, stopped, or returned. */
function lastSendOf(order: OrderProjection, orderFacts: readonly WorkFact[]): Extract<WorkWaitOutput, { kind: "ready" }>["last_send"] {
  switch (order.delivery) {
    case "withdrawn": {
      const fact = last(ofKind(orderFacts, "send_withdrawn"));
      return { delivery: "withdrawn", at: fact?.occurredAt ?? null, reason: fact?.data.reason ?? null };
    }
    case "stopped": {
      const stopped = last(ofKind(orderFacts, "stopped"));
      const asked = last(ofKind(orderFacts, "stop_requested"));
      return { delivery: "stopped", at: stopped?.occurredAt ?? null, reason: asked?.data.reason ?? null };
    }
    case "returned":
      return { delivery: "returned", at: order.returned?.at ?? null, reason: order.returned?.reason ?? null };
    default:
      return null;
  }
}

/** The time of the latest fact of `kind` on a send, or null. */
function lastAt(orderFacts: readonly WorkFact[], kind: FactKind): string | null {
  return last(orderFacts.filter((fact) => fact.kind === kind))?.occurredAt ?? null;
}

/**
 * The required check a send in review waits on, the one the checks word reads
 * (requiredCheckHoldOf). reviewGate stops at the first required check in name
 * order, so on its own it could name a missing check while the word reads
 * failing because another check failed (#5181).
 */
function requiredCheckWaitOf(order: OrderProjection, head: string): WorkWaitOutput {
  const hold = requiredCheckHoldOf(order);
  if (hold?.kind === "failed") return { kind: "check_failed", check: hold.name, conclusion: hold.conclusion, head };
  if (hold?.kind === "missing") return { kind: "check_missing", check: hold.name, head };
  return { kind: "checks_running", head };
}

/**
 * What a send in review waits for. A pull request closed without merging is
 * read first, because nothing after it can make the item done, even an
 * acceptance already on its head. A merge by the Oxagen GitHub App comes
 * next, for the same reason. Then an acceptance on the head and a merge, the
 * pull request and its head, an acceptance a newer head voided, and last the
 * review gate on the required checks.
 */
function reviewWaitOf(
  projection: WorkItemProjection,
  order: OrderProjection,
  orderFacts: readonly WorkFact[],
  lookups: Pick<Lookups, "names">,
): WorkWaitOutput {
  if (order.prClosed) return { kind: "pr_closed", at: lastAt(orderFacts, "pr_closed") };
  const app = appMergerOf(order);
  if (app !== null && order.merge !== null) return { kind: "merged_by_app", login: app.login, at: order.merge.at };
  if (order.acceptance !== null && order.merge === null) {
    return { kind: "accepted_waiting_merge", by: nameOf(lookups, order.acceptance.actor), head: order.acceptance.headSha };
  }
  if (order.merge !== null && order.acceptance === null) return { kind: "merged_before_review", at: order.merge.at };
  if (order.pullRequest === null) return { kind: "no_pull_request" };
  const head = order.head;
  if (head === null) return { kind: "no_head" };
  if (order.staleAcceptance !== null) {
    const seen = last(ofKind(orderFacts, "head_observed").filter((fact) => fact.headSha === head));
    return { kind: "new_head", head, earlier: order.staleAcceptance.headSha, at: seen?.occurredAt ?? null };
  }
  const gate = reviewGate(projection, order);
  if (gate.open) {
    return gate.requiredChecks.length === 0 ? { kind: "no_required_checks", head } : { kind: "ready_for_review", head };
  }
  switch (gate.block) {
    case "brief_out_of_date":
      return { kind: "brief_out_of_date" };
    case "checks_unknown":
      return { kind: "checks_unread", head };
    case "check_missing":
    case "check_failed":
      return requiredCheckWaitOf(order, head);
    case "pr_closed":
      return { kind: "pr_closed", at: lastAt(orderFacts, "pr_closed") };
    case "no_pull_request":
      return { kind: "no_pull_request" };
    case "no_head":
      return { kind: "no_head" };
    case "already_accepted":
      return { kind: "accepted_waiting_merge", by: nameOf(lookups, order.acceptance?.actor), head };
    default:
      // order_closed and run_active cannot hold for a send in review: review
      // means the send is open and its run ended or its pull request merged.
      // merged_by_app is read above. The head is known, so the checks are
      // what is left to read.
      return { kind: "checks_unread", head };
  }
}

/** What the item waits for. Pure. */
export function waitOf(item: DerivedItem, lookups: Lookups): WorkWaitOutput {
  const { projection } = item;
  const sorted = sortFacts(item.facts);
  const active = projection.activeOrder;
  switch (projection.state) {
    case "closed": {
      const closure = projection.closure;
      if (closure === null) break;
      return { kind: "closed", resolution: closure.resolution, by: nameOf(lookups, closure.actor), at: closure.at, reason: closure.reason };
    }
    case "done": {
      const done = latestDoneInCycle(projection);
      if (done === null || done.acceptance === null || done.merge === null) break;
      return {
        kind: "done",
        accepted: { by: nameOf(lookups, done.acceptance.actor), at: done.acceptance.at, head: done.acceptance.headSha },
        merged_at: done.merge.at,
      };
    }
    case "new": {
      if (projection.triage.outcome !== "failed") return { kind: "triaging" };
      const failure = last(ofKind(sorted, "triage_failed"));
      return { kind: "triage_failed", reason: failure?.data.reason ?? "Triage did not finish." };
    }
    case "held": {
      if (projection.triage.outcome !== "duplicate") return { kind: "out_of_scope" };
      const original = projection.triage.duplicateOf === null ? undefined : lookups.items.get(projection.triage.duplicateOf);
      return { kind: "possible_duplicate", of: original === undefined ? null : { id: original.id, number: original.number } };
    }
    case "needs_info":
      return { kind: "needs_info", question: item.triage.questions[0] ?? null };
    case "triaged": {
      const reopened = reopenedOf(item, sorted, lookups);
      if (projection.latestBrief !== null) return { kind: "brief_to_approve", from_triage: false, reopened };
      const criteria = item.triage.criteria.value ?? [];
      return criteria.length > 0 ? { kind: "brief_to_approve", from_triage: true, reopened } : { kind: "brief_to_write" };
    }
    case "changed": {
      const cause = projection.revisionCause === "brief" ? "brief" : "source";
      return {
        kind: "changed",
        cause,
        at: revisionMovedAt(sorted, projection.revision, cause),
        approved_revision: projection.lastApproval?.revision ?? null,
      };
    }
    case "ready": {
      const latest = latestInCycle(projection);
      if (latest === null) return { kind: "ready", last_send: null };
      const orderFacts = factsOfOrder(sorted, latest.orderId);
      if (latest.delivery === "rejected") {
        const rejected = last(ofKind(orderFacts, "send_rejected"));
        return { kind: "send_rejected", at: rejected?.occurredAt ?? null, reason: rejected?.data.reason ?? "The host could not keep the work order." };
      }
      return { kind: "ready", last_send: lastSendOf(latest, orderFacts) };
    }
    case "sent": {
      if (active === null) break;
      const runtime = runtimeNameOf(active, lookups);
      const lastPoll = lastPollOf(active, lookups);
      if (activeNoAnswer(item, lookups)) return { kind: "no_answer", runtime, last_poll_at: lastPoll };
      return { kind: "waiting_for_claim", runtime, sent_at: active.requestedAt, last_poll_at: lastPoll };
    }
    case "running": {
      if (active === null) break;
      if (active.delivery === "stopping") return { kind: "stopping", runtime: runtimeNameOf(active, lookups) };
      const mover = projection.changedSinceSend
        ? sorted.find((fact) => fact.itemRevision > active.itemRevision && movesRevision(fact))
        : undefined;
      return {
        kind: "running",
        changed_since_send: projection.changedSinceSend,
        changed_at: mover?.occurredAt ?? null,
        brief_revision: active.briefRevision,
      };
    }
    case "review": {
      if (active === null) break;
      return reviewWaitOf(projection, active, factsOfOrder(sorted, active.orderId), lookups);
    }
  }
  // The projection always carries what its state needs (reduceWorkItem), so
  // this is reached only by a record that breaks that rule. Say nothing more
  // than that triage is running rather than invent a cause.
  return { kind: "triaging" };
}

/** A send's row, which the read resolved for every send in the facts. */
export function orderRowOf(lookups: Pick<Lookups, "orders">, orderId: string): OrderRowRef {
  const row = lookups.orders.get(orderId);
  // A fact names its order through a foreign key (item_facts_order_fk), so
  // the row is always there. A read that lost it is a bug in the read.
  if (row === undefined) throw new Error(`The work order ${orderId} named by the facts was not read.`);
  return row;
}

/** The agent a send went to, by name. Every field is null when the agent row is gone. Pure. */
export function agentRefOf(order: OrderProjection, lookups: Pick<Lookups, "agents">): WorkSendSummary["agent"] {
  const agent = lookups.agents.get(order.agentId);
  return agent === undefined ? { id: null, name: null, harness: null } : { id: agent.publicId, name: agent.name, harness: agent.harness };
}

/** The GitHub link to a pull request. Pure. */
export function pullRequestUrl(repository: string, number: number): string {
  return `https://github.com/${repository}/pull/${number}`;
}

/**
 * A send's pull request, by repository and number, with its head, from the
 * send's facts. The link is the forge store's when it holds the same pull
 * request, and the GitHub link otherwise. Pure.
 */
export function pullRequestRefOf(order: OrderProjection, lookups: Pick<Lookups, "pullRequests">): WorkSendSummary["pull_request"] {
  if (order.pullRequest === null) return null;
  const { repository, number } = order.pullRequest;
  const held = lookups.pullRequests
    .get(order.orderId)
    ?.find((pull) => pull.provider === "github" && pull.number === number && pull.repository === repository.toLowerCase());
  return { repository, number, url: held?.url ?? pullRequestUrl(repository, number), head: order.head };
}

/** Every pull request a send has in the forge store, newest first. Pure. */
export function forgePullRequestsOf(order: OrderProjection, lookups: Pick<Lookups, "pullRequests">): WorkSendSummary["pull_requests"] {
  return (lookups.pullRequests.get(order.orderId) ?? []).map((pull) => ({
    id: pull.id,
    provider: pull.provider,
    repository: pull.repository,
    number: pull.number,
    url: pull.url,
    title: pull.title,
    state: pull.state,
    head: pull.headSha,
    state_seen_at: pull.stateSeenAt,
  }));
}

/** One send, as a list row shows it. Pure. */
export function sendSummaryOf(item: Pick<DerivedItem, "facts" | "projection">, order: OrderProjection, lookups: Lookups): WorkSendSummary {
  const row = orderRowOf(lookups, order.orderId);
  return {
    id: row.publicId,
    send: order.send,
    key: order.key,
    delivery: order.delivery,
    no_answer: noAnswerOf(order, factsOfOrder(item.facts, order.orderId), row.commandOutcome),
    agent: agentRefOf(order, lookups),
    runtime: { name: runtimeNameOf(order, lookups), tier: order.runtimeTier },
    requested_at: order.requestedAt,
    pull_request: pullRequestRefOf(order, lookups),
    pull_requests: forgePullRequestsOf(order, lookups),
    checks: checksWordOf(order),
    gate: gateOf(item.projection, order),
    accepted: order.acceptance !== null,
  };
}

/** When the item was done or closed. Null while it is open. Pure. */
export function finishedAtOf(projection: WorkItemProjection): string | null {
  if (projection.state === "closed") return projection.closure?.at ?? null;
  if (projection.state === "done") {
    const done = latestDoneInCycle(projection);
    return done === null ? null : doneAtOf(done);
  }
  return null;
}

/** One work item, as the Work page's tables show it. Pure. */
export function rowOf(item: DerivedItem, lookups: Lookups): WorkItemRowOutput {
  const { columns, projection } = item;
  const latest = latestInCycle(projection);
  return {
    id: columns.publicId,
    number: columns.number,
    title: columns.title,
    origin: columns.origin,
    source_url: columns.sourceUrl,
    repository: columns.repository,
    requester: columns.requester,
    labels: [...columns.labels],
    arrived_at: columns.arrivedAt,
    finished_at: finishedAtOf(projection),
    state: projection.state,
    status: statusOf(projection, activeNoAnswer(item, lookups)),
    tab: tabOf(projection.state),
    version: columns.version,
    revision: projection.revision,
    priority: priorityViewOf(item.triage, lookups),
    wait: waitOf(item, lookups),
    send: latest === null ? null : sendSummaryOf(item, latest, lookups),
    cost: costOf(itemRunIds(projection), lookups.runs),
  };
}
