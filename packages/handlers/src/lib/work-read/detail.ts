// detail.ts: one work item with everything a person decides on, as
// get_work_item answers it (P1-05, #5163; agent-work-phase-1.html, Screens:
// Work item).
//
// Pure, like derive.ts: read.ts gathers the item's records and the rows they
// name, and these functions shape them. The answer carries the source
// revisions, triage with every correction in force, every brief revision and
// its approval, every send with its delivery, runs, pull request, required
// checks, acceptance, and cost, and the history in canonical order. Names are
// display names the read resolved. The source's text is data, and nothing here
// reads it as an instruction.
import type { WorkItemGetOutput } from "@oxagen/oxagen/contracts/work.item.get";
import type { TriageCorrection, TriageField, TriageView } from "@oxagen/work";
import {
  type AcceptanceRef,
  type FactKind,
  type FactOf,
  type OrderProjection,
  type WorkBrief,
  type WorkFact,
  type WorkItemProjection,
  sortFacts,
  workOrderKey,
} from "@oxagen/work/records";
import {
  type DerivedItem,
  type Lookups,
  agentRefOf,
  checksWordOf,
  costOf,
  factsOfOrder,
  gateOf,
  nameOf,
  noAnswerOf,
  orderRowOf,
  pullRequestRefOf,
  rowOf,
} from "./derive";

export type WorkItemDetail = Omit<WorkItemGetOutput, "viewer">;
type ItemOut = WorkItemDetail["item"];
type SendOut = WorkItemDetail["sends"][number];
type HistoryOut = WorkItemDetail["history"][number];
type BriefOut = WorkItemDetail["brief"];
type TriageOut = WorkItemDetail["triage"];
type AcceptanceOut = NonNullable<SendOut["acceptance"]>;
type CheckOut = SendOut["checks"][number];

/** One stored brief revision, as the store reads it. */
export interface DetailBrief {
  briefId: string;
  /** The brief's public id (`brf_…`). */
  publicId: string;
  revision: number;
  itemRevision: number;
  digest: string;
  brief: WorkBrief;
  /** Who wrote it: a user id, or `triage`. */
  author: string;
}

/** The item's records beyond what a list row reads. */
export interface DetailInput extends DerivedItem {
  /** The source's current description. */
  description: string | null;
  /** The collector that brought it in, or null for an item a person entered. */
  collector: ItemOut["collector"];
  /** Every saved brief revision, in any order. */
  briefs: readonly DetailBrief[];
  /** The latest triage decision's model and time, or null before triage decided. */
  decision: { model: string | null; at: string } | null;
  /** Every correction the item holds, oldest first. */
  corrections: readonly TriageCorrection[];
  /**
   * The display name of an actor that is not a person: a host's hostname for
   * a runtime's fact, an agent's name for an agent's fact. Absent or null when
   * the read could not resolve it.
   */
  actorNames: ReadonlyMap<string, string | null>;
}

function last<T>(list: readonly T[]): T | undefined {
  return list[list.length - 1];
}

function ofKind<K extends FactKind>(facts: readonly WorkFact[], kind: K): FactOf<K>[] {
  return facts.filter((fact) => fact.kind === kind) as unknown as FactOf<K>[];
}

function firstAt(facts: readonly WorkFact[], kind: FactKind): string | null {
  return facts.find((fact) => fact.kind === kind)?.occurredAt ?? null;
}

function lastAt(facts: readonly WorkFact[], kind: FactKind): string | null {
  return last(facts.filter((fact) => fact.kind === kind))?.occurredAt ?? null;
}

function sameRepository(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Every reading of the source, oldest first. Pure. */
export function sourceRevisionsOf(facts: readonly WorkFact[]): ItemOut["source_revisions"] {
  const out: ItemOut["source_revisions"] = [];
  for (const fact of sortFacts(facts)) {
    if (fact.kind !== "collected" && fact.kind !== "entered" && fact.kind !== "source_changed") continue;
    out.push({
      revision: fact.itemRevision,
      at: fact.occurredAt,
      kind: fact.kind === "source_changed" ? "changed" : fact.kind,
      subject: fact.data.subject,
      description: fact.data.description,
      labels: [...fact.data.labels],
    });
  }
  return out;
}

/**
 * The triage view as the contract spells it. Each field's `actor` is the
 * display name of the person who corrected it, not their user id. Pure.
 */
export function triageViewOutput(view: TriageView, lookups: Pick<Lookups, "names">): TriageOut["view"] {
  const field = <T>(entry: TriageField<T>): TriageField<T> => ({
    value: entry.value,
    by: entry.by,
    actor: nameOf(lookups, entry.actor),
    at: entry.at,
  });
  return {
    decision: view.decision,
    priority: field(view.priority),
    priority_reason: view.priorityReason,
    cites: [...view.cites],
    estimate_minutes: field(view.estimate_minutes),
    labels: field({ ...view.labels, value: view.labels.value === null ? null : [...view.labels.value] }),
    claims: field({ ...view.claims, value: view.claims.value === null ? null : [...view.claims.value] }),
    criteria: field({ ...view.criteria, value: view.criteria.value === null ? null : [...view.criteria.value] }),
    questions: [...view.questions],
    duplicates: [...view.duplicates],
    related: [...view.related],
    conflicts: [...view.conflicts],
  };
}

/**
 * Where triage stands on the item: the view, the outcome in force, the
 * decision's model and time, the latest run's failure, a person's override
 * while it is in force, and every correction. Pure.
 */
export function triageOf(input: Pick<DetailInput, "facts" | "projection" | "triage" | "decision" | "corrections">, lookups: Pick<Lookups, "names">): TriageOut {
  const facts = sortFacts(input.facts);
  const latestRun = last(facts.filter((fact) => fact.kind === "triage_recorded" || fact.kind === "triage_failed"));
  const failure = latestRun?.kind === "triage_failed" ? { reason: latestRun.data.reason, at: latestRun.occurredAt } : null;
  // An override holds until a person clears it with a null outcome.
  const override = last(ofKind(facts, "triage_overridden"));
  return {
    view: triageViewOutput(input.triage, lookups),
    standing: {
      outcome: input.projection.triage.outcome,
      by: input.projection.triage.by,
      duplicate_of: input.projection.triage.duplicateOf,
    },
    decided_at: input.decision?.at ?? null,
    model: input.decision?.model ?? null,
    failure,
    override:
      override === undefined || override.data.outcome === null
        ? null
        : { outcome: override.data.outcome, reason: override.data.reason, by: nameOf(lookups, override.actor), at: override.occurredAt },
    corrections: input.corrections.map((correction) => ({
      field: correction.field,
      before: correction.before,
      after: correction.after,
      by: nameOf(lookups, correction.by),
      at: correction.at,
    })),
  };
}

/**
 * Where the brief stands. `none`: nothing to approve. `triage_draft`: triage
 * drafted criteria nobody saved. `out_of_date`: the item changed after
 * approval, or a running send went out on an earlier revision. `approved`:
 * the current revision has an approval. `draft`: a saved revision waits for
 * one. Pure.
 */
export function briefStateOf(projection: WorkItemProjection, triageCriteria: readonly string[]): BriefOut["state"] {
  if (projection.latestBrief === null) return triageCriteria.length > 0 ? "triage_draft" : "none";
  if (projection.state === "changed") return "out_of_date";
  if (projection.activeOrder !== null && projection.changedSinceSend) return "out_of_date";
  if (projection.approvedBrief !== null) return "approved";
  return "draft";
}

/** The brief: its state, every saved revision, triage's draft, and the repository a new revision starts with. Pure. */
export function briefOf(input: Pick<DetailInput, "facts" | "projection" | "triage" | "briefs" | "columns">, lookups: Pick<Lookups, "names">): BriefOut {
  const facts = sortFacts(input.facts);
  const saves = ofKind(facts, "brief_saved");
  const approvals = ofKind(facts, "brief_approved");
  const briefs = [...input.briefs].sort((a, b) => a.revision - b.revision);
  const triageCriteria = input.projection.latestBrief === null ? [...(input.triage.criteria.value ?? [])] : [];
  const revisions = briefs.map((stored) => {
    const saved = saves.find((fact) => fact.briefId === stored.briefId) ?? saves.find((fact) => fact.data.revision === stored.revision);
    const approved = last(approvals.filter((fact) => fact.briefId === stored.briefId || fact.data.revision === stored.revision));
    return {
      id: stored.publicId,
      revision: stored.revision,
      item_revision: stored.itemRevision,
      digest: stored.digest,
      repository: stored.brief.repository,
      // The store writes the brief row and its brief_saved fact in one
      // transaction, so the fact is there. The item's arrival is the floor.
      author: stored.author === "triage" ? null : nameOf(lookups, stored.author),
      saved_at: saved?.occurredAt ?? input.columns.arrivedAt,
      criteria: stored.brief.criteria.map((criterion) => ({
        criterion: criterion.id,
        text: criterion.text,
        tag: criterion.tag,
        intent: criterion.intent,
        evidence: criterion.evidence,
        provenance: criterion.provenance,
      })),
      approved: approved === undefined ? null : { by: nameOf(lookups, approved.actor), at: approved.occurredAt },
    };
  });
  return {
    state: briefStateOf(input.projection, triageCriteria),
    revisions,
    triage_criteria: triageCriteria,
    repository: last(briefs)?.brief.repository ?? input.columns.repository,
  };
}

/**
 * The key and number of the next send, when the approved brief allows one:
 * the current revision has an approval, no send is open, and the item is
 * neither done nor closed (the send refuses both). Pure.
 */
export function nextSendOf(publicId: string, projection: WorkItemProjection): WorkItemDetail["next_send"] {
  const approved = projection.approvedBrief;
  if (approved === null || projection.activeOrder !== null) return null;
  if (projection.state === "done" || projection.state === "closed") return null;
  return { send: projection.nextSend, key: workOrderKey(publicId, approved.revision, projection.nextSend) };
}

function acceptanceOut(acceptance: AcceptanceRef | null, lookups: Pick<Lookups, "names">): AcceptanceOut | null {
  if (acceptance === null) return null;
  return {
    head: acceptance.headSha,
    by: nameOf(lookups, acceptance.actor),
    at: acceptance.at,
    criteria: [...acceptance.criteria],
    required_checks: [...acceptance.requiredChecks],
  };
}

/** Whether a fact names the send's current pull request, or names none. */
function onPullRequest(order: OrderProjection, fact: WorkFact): boolean {
  const pr = order.pullRequest;
  if (pr === null || fact.repository === null || fact.prNumber === null) return true;
  return sameRepository(fact.repository, pr.repository) && fact.prNumber === pr.number;
}

/**
 * The latest check results recorded on the most recent head before the
 * current one. They decide nothing on the current head. Null when the pull
 * request had no earlier head. Pure.
 */
export function earlierChecksOf(order: OrderProjection, orderFacts: readonly WorkFact[]): SendOut["earlier_checks"] {
  if (order.head === null) return null;
  const facts = sortFacts(orderFacts);
  const earlier = last(ofKind(facts, "head_observed").filter((fact) => fact.headSha !== order.head && onPullRequest(order, fact)));
  const head = earlier?.headSha ?? null;
  if (head === null) return null;
  const required = last(ofKind(facts, "checks_required").filter((fact) => fact.headSha === head));
  const names = required === undefined ? null : new Set(required.data.names);
  const latest = new Map<string, CheckOut["conclusion"]>();
  for (const fact of ofKind(facts, "check_observed")) {
    if (fact.headSha === head) latest.set(fact.data.name, fact.data.conclusion);
  }
  const checks = [...latest.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, conclusion]) => ({ name, conclusion, required: names?.has(name) ?? false }));
  return { head, checks };
}

/** One send with everything its review rests on. Pure. */
export function sendDetailOf(item: Pick<DerivedItem, "facts" | "projection">, order: OrderProjection, lookups: Lookups): SendOut {
  const row = orderRowOf(lookups, order.orderId);
  const facts = sortFacts(factsOfOrder(item.facts, order.orderId));
  const rejected = last(ofKind(facts, "send_rejected"));
  const withdrawn = last(ofKind(facts, "send_withdrawn"));
  const stopAsked = last(ofKind(facts, "stop_requested"));
  const ref = pullRequestRefOf(order);
  const headSeen =
    order.head === null
      ? undefined
      : last(ofKind(facts, "head_observed").filter((fact) => fact.headSha === order.head && onPullRequest(order, fact)));
  return {
    id: row.publicId,
    send: order.send,
    key: order.key,
    delivery: order.delivery,
    no_answer: noAnswerOf(order, facts, row.commandOutcome),
    ended: order.closed,
    item_revision: order.itemRevision,
    brief_revision: order.briefRevision,
    brief_digest: order.briefDigest,
    agent: agentRefOf(order, lookups),
    runtime: { name: lookups.runtimes.get(order.runtimeId)?.name ?? null, tier: order.runtimeTier },
    host: row.host === null ? null : { name: row.host.name, last_poll_at: row.host.lastPollAt },
    operator: nameOf(lookups, order.operatorId),
    mandate_id: row.mandateId,
    requested_at: order.requestedAt,
    delivered_at: firstAt(facts, "send_delivered"),
    claimed_at: firstAt(facts, "claimed"),
    first_run_at: firstAt(facts, "run_linked"),
    run_ended_at: lastAt(facts, "run_ended"),
    rejected: rejected === undefined ? null : { reason: rejected.data.reason, at: rejected.occurredAt },
    withdrawn: withdrawn === undefined ? null : { reason: withdrawn.data.reason, by: nameOf(lookups, withdrawn.actor), at: withdrawn.occurredAt },
    stop_requested:
      stopAsked === undefined ? null : { reason: stopAsked.data.reason, by: nameOf(lookups, stopAsked.actor), at: stopAsked.occurredAt },
    stopped_at: lastAt(facts, "stopped"),
    returned: order.returned === null ? null : { reason: order.returned.reason, by: nameOf(lookups, order.returned.actor), at: order.returned.at },
    runs: order.runIds.map((runId) => {
      const run = lookups.runs.get(runId);
      return {
        id: runId,
        cost: run === undefined || run.costMicros === null ? null : { micros: run.costMicros.toString(), currency: run.currency },
        basis: run?.basis ?? null,
        tier: run?.tier ?? null,
      };
    }),
    cost: costOf(order.runIds, lookups.runs),
    pull_request:
      ref === null
        ? null
        : {
            ...ref,
            head_at: headSeen?.occurredAt ?? null,
            merged: order.merge === null ? null : { at: order.merge.at, merge_commit: order.merge.mergeCommit },
            closed_at: order.prClosed ? lastAt(facts.filter((fact) => onPullRequest(order, fact)), "pr_closed") : null,
          },
    required_checks: order.requiredChecks === null ? null : [...order.requiredChecks],
    checks: order.checks.map((check) => ({ name: check.name, conclusion: check.conclusion, required: check.required })),
    earlier_checks: earlierChecksOf(order, facts),
    checks_word: checksWordOf(order),
    gate: gateOf(item.projection, order),
    acceptance: acceptanceOut(order.acceptance, lookups),
    stale_acceptance: acceptanceOut(order.staleAcceptance, lookups),
    claims: order.claims.map((claim) => ({ criterion: claim.criterionId, text: claim.text, head: claim.headSha, current: claim.current })),
  };
}

/** The reason, resolution, outcome, check, merge commit, and brief revision a fact carries. */
function detailsOf(fact: WorkFact): Pick<HistoryOut, "reason" | "resolution" | "outcome" | "check" | "conclusion" | "merge_commit" | "brief_revision"> {
  const none = { reason: null, resolution: null, outcome: null, check: null, conclusion: null, merge_commit: null, brief_revision: null };
  switch (fact.kind) {
    case "triage_recorded":
      return { ...none, outcome: fact.data.outcome };
    case "triage_failed":
    case "send_rejected":
    case "send_withdrawn":
    case "stop_requested":
    case "returned":
    case "reopened":
      return { ...none, reason: fact.data.reason };
    case "triage_overridden":
      return { ...none, reason: fact.data.reason, outcome: fact.data.outcome };
    case "closed":
      return { ...none, reason: fact.data.reason, resolution: fact.data.resolution };
    case "brief_saved":
    case "brief_approved":
      return { ...none, brief_revision: fact.data.revision };
    case "send_requested":
      return { ...none, brief_revision: fact.data.brief_revision };
    case "run_ended":
      return { ...none, outcome: fact.data.outcome };
    case "check_observed":
      return { ...none, check: fact.data.name, conclusion: fact.data.conclusion };
    case "merged":
      return { ...none, merge_commit: fact.data.merge_commit };
    default:
      return none;
  }
}

/**
 * Every fact in canonical order, with who acted by display name and the
 * details a page names. A person's fact names the person, a runtime's or an
 * agent's names the host or agent the read resolved, and Oxagen's and the
 * provider's name nobody. Pure.
 */
export function historyOf(input: Pick<DetailInput, "facts" | "projection" | "actorNames">, lookups: Pick<Lookups, "names">): HistoryOut[] {
  const sends = new Map(input.projection.orders.map((order) => [order.orderId, order.send]));
  return sortFacts(input.facts).map((fact) => {
    let actor: string | null = null;
    if (fact.source === "person") actor = nameOf(lookups, fact.actor);
    else if (fact.source === "runtime" || fact.source === "agent") actor = input.actorNames.get(fact.actor) ?? null;
    return {
      kind: fact.kind,
      source: fact.source,
      actor,
      at: fact.occurredAt,
      item_revision: fact.itemRevision,
      send: fact.orderId === null ? null : (sends.get(fact.orderId) ?? null),
      head: fact.headSha,
      pull_request: fact.repository !== null && fact.prNumber !== null ? `${fact.repository}#${fact.prNumber}` : null,
      ...detailsOf(fact),
    };
  });
}

/** The whole answer of get_work_item, less the viewer the handler adds. Pure. */
export function detailOf(input: DetailInput, lookups: Lookups): WorkItemDetail {
  const item: ItemOut = {
    ...rowOf(input, lookups),
    description: input.description,
    source_revisions: sourceRevisionsOf(input.facts),
    collector: input.collector,
  };
  return {
    item,
    triage: triageOf(input, lookups),
    brief: briefOf(input, lookups),
    next_send: nextSendOf(input.columns.publicId, input.projection),
    sends: [...input.projection.orders].sort((a, b) => b.send - a.send).map((order) => sendDetailOf(input, order, lookups)),
    history: historyOf(input, lookups),
  };
}
