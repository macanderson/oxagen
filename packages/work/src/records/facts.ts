// facts.ts: the append-only facts a work item's history is made of.
//
// A fact records one thing that happened to a work item or to one of its work
// orders: the source changed, triage suggested, a person approved a brief, a
// runtime claimed a send, the provider reported a head commit or a check, a
// person accepted or returned the work, the pull request merged. Facts are
// stored in work.item_facts and never change. The item's state is a projection
// of its facts (reduce.ts), so the same facts always give the same state,
// whatever order they arrived in.
//
// Each fact names a trusted source. A source may record only the kinds listed
// for it in FACT_SOURCES_BY_KIND, so an agent's claim can never pass for a
// person's acceptance or a provider's merge. Facts from an agent never move
// the item's state: Phase 1 shows a claim and leaves the judgment to a person.
import type { Sha256Digest } from "@oxagen/run-evidence";
import { TRIAGE_STATES, type TriageState } from "../types";
import { WorkRecordError } from "./errors";

/** Facts about the work item itself. They carry no work order. */
export const ITEM_FACT_KINDS = [
  "collected",
  "entered",
  "source_changed",
  "triage_recorded",
  "triage_failed",
  "triage_overridden",
  "brief_saved",
  "brief_approved",
  "closed",
  "reopened",
] as const;

/** Facts about one work order. Each names the order. */
export const ORDER_FACT_KINDS = [
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
] as const;

/** Every fact kind, in the order a tie in time is broken. */
export const FACT_KINDS = [...ITEM_FACT_KINDS, ...ORDER_FACT_KINDS] as const;
export type ItemFactKind = (typeof ITEM_FACT_KINDS)[number];
export type OrderFactKind = (typeof ORDER_FACT_KINDS)[number];
export type FactKind = (typeof FACT_KINDS)[number];

/** Who reported a fact. */
export const FACT_SOURCES = [
  /** The source provider, such as GitHub: the item, the pull request, its checks, and its merge. */
  "provider",
  /** The enrolled runtime that received the work order. */
  "runtime",
  /** The agent doing the work. Its facts are claims and never move the state. */
  "agent",
  /** A signed-in person. */
  "person",
  /** Oxagen itself: triage and delivery. */
  "oxagen",
] as const;
export type FactSource = (typeof FACT_SOURCES)[number];

/** The sources allowed to record each kind. */
export const FACT_SOURCES_BY_KIND: Readonly<Record<FactKind, readonly FactSource[]>> = {
  collected: ["provider"],
  entered: ["person"],
  source_changed: ["provider", "person"],
  triage_recorded: ["oxagen"],
  triage_failed: ["oxagen"],
  triage_overridden: ["person"],
  brief_saved: ["person", "oxagen"],
  brief_approved: ["person"],
  closed: ["person"],
  reopened: ["person"],
  send_requested: ["person"],
  send_delivered: ["oxagen"],
  send_rejected: ["runtime", "oxagen"],
  send_withdrawn: ["person"],
  claimed: ["runtime"],
  run_linked: ["runtime"],
  run_ended: ["runtime"],
  stop_requested: ["person"],
  stopped: ["runtime"],
  pr_linked: ["runtime", "provider"],
  head_observed: ["provider"],
  checks_required: ["provider"],
  check_observed: ["provider"],
  criterion_claimed: ["agent"],
  returned: ["person"],
  accepted: ["person"],
  merged: ["provider"],
  pr_closed: ["provider"],
};

/** The kinds a person decides, which carry the caller's item version. */
export const DECISION_FACT_KINDS = [
  "triage_overridden",
  "brief_saved",
  "brief_approved",
  "closed",
  "reopened",
  "send_requested",
  "send_withdrawn",
  "stop_requested",
  "returned",
  "accepted",
] as const satisfies readonly FactKind[];

/** How a person closes a work item without finishing it. */
export const CLOSE_RESOLUTIONS = ["cancelled", "declined", "duplicate"] as const;
export type CloseResolution = (typeof CLOSE_RESOLUTIONS)[number];

/** A check's conclusion on a commit. Only success lets a required check pass. */
export const CHECK_CONCLUSIONS = [
  "success",
  "failure",
  "cancelled",
  "skipped",
  "neutral",
  "timed_out",
  "action_required",
  "stale",
  "pending",
] as const;
export type CheckConclusion = (typeof CHECK_CONCLUSIONS)[number];

/** How far a runtime enforces a budget: before a call on gateway and contained, after the run on harness and observe. */
export const RUNTIME_TIERS = ["contained", "gateway", "harness", "observe"] as const;
export type RuntimeTier = (typeof RUNTIME_TIERS)[number];

/** A triage suggestion's outcome. The same list as triage/v1's state. */
export type TriageOutcome = TriageState;
export const TRIAGE_OUTCOMES = TRIAGE_STATES;

/** A full Git commit id. */
export const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** A run's public id: a ledger run or a tacho session. */
export const RUN_ID_PATTERN = /^(arun|tse)_[0-9a-z]+$/;

/** The longest dedupe key, actor, reason, or claim text a fact carries. */
export const MAX_FACT_TEXT = 2000;

/** A source item's material fields as one revision read them. */
export interface SourceSnapshot {
  digest: Sha256Digest;
  subject: string;
  description: string | null;
  labels: string[];
}

/** The data each kind carries beside the fact's columns. */
export interface FactDataByKind {
  collected: SourceSnapshot;
  entered: SourceSnapshot;
  source_changed: SourceSnapshot & { previous_digest: Sha256Digest | null };
  /** `decision` is the triage decision's public id. */
  triage_recorded: { decision: string; outcome: TriageOutcome; duplicate_of: string | null };
  triage_failed: { reason: string };
  /** A null outcome clears an earlier override, so triage decides again. */
  triage_overridden: { outcome: TriageOutcome | null; duplicate_of: string | null; reason: string };
  /** `revises` is true when the save replaced an approved brief and moved the item revision. */
  brief_saved: { revision: number; revises: boolean };
  brief_approved: { revision: number };
  closed: { resolution: CloseResolution; reason: string };
  /** `after_send` is the highest send number before the reopen. Earlier sends stay history. */
  reopened: { reason: string; after_send: number };
  send_requested: {
    send: number;
    brief_revision: number;
    key: string;
    agent_id: string;
    runtime_id: string;
    runtime_tier: RuntimeTier;
    operator_id: string;
  };
  send_delivered: { command_id: string | null };
  send_rejected: { reason: string };
  send_withdrawn: { reason: string };
  claimed: { host: string | null };
  run_linked: Record<string, never>;
  run_ended: { outcome: string | null };
  stop_requested: { reason: string };
  stopped: Record<string, never>;
  pr_linked: Record<string, never>;
  head_observed: Record<string, never>;
  /** The checks the base branch requires on the head commit. Empty means none is required. */
  checks_required: { names: string[] };
  check_observed: { name: string; conclusion: CheckConclusion };
  criterion_claimed: { text: string };
  returned: { reason: string };
  /** `criteria` is every criterion id the person ticked. `required_checks` is what the base branch required. */
  accepted: { criteria: string[]; required_checks: string[] };
  merged: { merge_commit: string };
  pr_closed: Record<string, never>;
}

interface FactBase<K extends FactKind> {
  kind: K;
  source: FactSource;
  /** The item revision the fact belongs to. An order's facts carry the revision the order was sent on. */
  itemRevision: number;
  /** The work order's row id. Set on every order fact and on no item fact. */
  orderId: string | null;
  /** The brief revision's row id, on brief and send facts. */
  briefId: string | null;
  briefDigest: Sha256Digest | null;
  /** The pull request's repository as owner/name. */
  repository: string | null;
  prNumber: number | null;
  headSha: string | null;
  runId: string | null;
  criterionId: string | null;
  /** Who acted: a user id, a runtime's public id, or the Oxagen step. */
  actor: string;
  /** When it happened, as an ISO 8601 time. A provider's own time where it has one. */
  occurredAt: string;
  /** Unique per item. A fact with a key already recorded is a repeat and changes nothing. */
  dedupeKey: string;
  data: FactDataByKind[K];
}

/** One fact, typed by its kind. */
export type WorkFact = { [K in FactKind]: FactBase<K> }[FactKind];

/** The fact of one kind. */
export type FactOf<K extends FactKind> = FactBase<K>;

type FactLink = "orderId" | "briefId" | "briefDigest" | "repository" | "prNumber" | "headSha" | "runId" | "criterionId";

/** A fact's required fields. Every link column it leaves out is null. */
export type FactInput<K extends FactKind> = Omit<FactBase<K>, FactLink> & Partial<Pick<FactBase<K>, FactLink>>;

/** Build a fact, with null in every link column the input leaves out. Pure. */
export function newFact<K extends FactKind>(input: FactInput<K>): FactOf<K> {
  return {
    orderId: null,
    briefId: null,
    briefDigest: null,
    repository: null,
    prNumber: null,
    headSha: null,
    runId: null,
    criterionId: null,
    ...input,
  } as unknown as FactOf<K>;
}

function invalid(message: string): WorkRecordError {
  return new WorkRecordError("invalid_input", message);
}

/** True for a kind that belongs to a work order. */
export function isOrderFactKind(kind: FactKind): kind is OrderFactKind {
  return (ORDER_FACT_KINDS as readonly string[]).includes(kind);
}

/** True for a kind a person decides. */
export function isDecisionFactKind(kind: FactKind): boolean {
  return (DECISION_FACT_KINDS as readonly string[]).includes(kind);
}

function text(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw invalid(`${label} must be non-empty text.`);
  if (value.length > MAX_FACT_TEXT) throw invalid(`${label} is longer than ${MAX_FACT_TEXT} characters.`);
}

function need(fact: WorkFact, column: keyof FactBase<FactKind>, label: string): void {
  if (fact[column] === null || fact[column] === undefined) {
    throw invalid(`A ${fact.kind} fact needs ${label}.`);
  }
}

function checkData(fact: WorkFact): void {
  switch (fact.kind) {
    case "collected":
    case "entered":
    case "source_changed":
      text(fact.data.subject, "The source subject");
      if (!Array.isArray(fact.data.labels)) throw invalid("The source labels must be a list.");
      return;
    case "triage_recorded":
      if (!(TRIAGE_OUTCOMES as readonly string[]).includes(fact.data.outcome)) {
        throw invalid(`The triage outcome "${String(fact.data.outcome)}" is not one of ${TRIAGE_OUTCOMES.join(", ")}.`);
      }
      return;
    case "triage_overridden":
      if (fact.data.outcome !== null && !(TRIAGE_OUTCOMES as readonly string[]).includes(fact.data.outcome)) {
        throw invalid(`The triage outcome "${String(fact.data.outcome)}" is not one of ${TRIAGE_OUTCOMES.join(", ")}.`);
      }
      text(fact.data.reason, "The reason for the triage change");
      return;
    case "triage_failed":
    case "send_rejected":
      text(fact.data.reason, "The reason");
      return;
    case "closed":
      if (!(CLOSE_RESOLUTIONS as readonly string[]).includes(fact.data.resolution)) {
        throw invalid(`The resolution "${String(fact.data.resolution)}" is not one of ${CLOSE_RESOLUTIONS.join(", ")}.`);
      }
      text(fact.data.reason, "The reason for closing");
      return;
    case "reopened":
      text(fact.data.reason, "The reason for reopening");
      return;
    case "stop_requested":
    case "returned":
    case "send_withdrawn":
      text(fact.data.reason, "The reason");
      return;
    case "send_requested":
      if (!(RUNTIME_TIERS as readonly string[]).includes(fact.data.runtime_tier)) {
        throw invalid(`The runtime tier "${String(fact.data.runtime_tier)}" is not one of ${RUNTIME_TIERS.join(", ")}.`);
      }
      return;
    case "check_observed":
      text(fact.data.name, "The check name");
      if (!(CHECK_CONCLUSIONS as readonly string[]).includes(fact.data.conclusion)) {
        throw invalid(`The check conclusion "${String(fact.data.conclusion)}" is not one of ${CHECK_CONCLUSIONS.join(", ")}.`);
      }
      return;
    case "checks_required":
      if (!Array.isArray(fact.data.names)) throw invalid("The required checks must be a list of names.");
      for (const name of fact.data.names) text(name, "A required check name");
      return;
    case "criterion_claimed":
      text(fact.data.text, "The claim");
      return;
    case "accepted":
      if (!Array.isArray(fact.data.criteria) || !Array.isArray(fact.data.required_checks)) {
        throw invalid("An acceptance lists the criteria a person ticked and the checks the base branch required.");
      }
      return;
    case "merged":
      if (!HEAD_SHA_PATTERN.test(fact.data.merge_commit)) throw invalid("A merge names its merge commit as 40 hex characters.");
      return;
    default:
      return;
  }
}

/**
 * Refuse a fact that is malformed or that its source may not record. This is
 * structure only: admit.ts decides whether the item's state allows it.
 */
export function checkFact(fact: WorkFact): void {
  if (!(FACT_KINDS as readonly string[]).includes(fact.kind)) throw invalid(`"${String(fact.kind)}" is not a fact kind.`);
  if (!FACT_SOURCES_BY_KIND[fact.kind].includes(fact.source)) {
    throw invalid(`A ${fact.kind} fact comes from ${FACT_SOURCES_BY_KIND[fact.kind].join(" or ")}, not ${String(fact.source)}.`);
  }
  if (!Number.isInteger(fact.itemRevision) || fact.itemRevision < 1) throw invalid("A fact's item revision is a whole number from 1.");
  if (isOrderFactKind(fact.kind) !== (fact.orderId !== null)) {
    throw invalid(isOrderFactKind(fact.kind) ? `A ${fact.kind} fact must name its work order.` : `A ${fact.kind} fact belongs to the item and names no work order.`);
  }
  text(fact.actor, "The actor");
  text(fact.dedupeKey, "The dedupe key");
  if (Number.isNaN(Date.parse(fact.occurredAt))) throw invalid(`"${fact.occurredAt}" is not a time.`);
  if (fact.headSha !== null && !HEAD_SHA_PATTERN.test(fact.headSha)) throw invalid("A head commit is 40 lowercase hex characters.");
  if (fact.runId !== null && !RUN_ID_PATTERN.test(fact.runId)) throw invalid(`"${fact.runId}" is not a run id.`);
  if (fact.prNumber !== null && (!Number.isInteger(fact.prNumber) || fact.prNumber < 1)) throw invalid("A pull request number is a whole number from 1.");

  switch (fact.kind) {
    case "brief_saved":
    case "brief_approved":
    case "send_requested":
      need(fact, "briefId", "the brief revision");
      need(fact, "briefDigest", "the brief digest");
      break;
    case "run_linked":
    case "run_ended":
      need(fact, "runId", "the run");
      break;
    case "pr_linked":
      need(fact, "repository", "the repository");
      need(fact, "prNumber", "the pull request number");
      break;
    case "head_observed":
      need(fact, "repository", "the repository");
      need(fact, "prNumber", "the pull request number");
      need(fact, "headSha", "the head commit");
      break;
    case "checks_required":
    case "check_observed":
    case "merged":
      need(fact, "headSha", "the head commit");
      break;
    case "criterion_claimed":
      need(fact, "criterionId", "the criterion");
      break;
    case "accepted":
      need(fact, "headSha", "the head commit it accepts");
      need(fact, "briefDigest", "the brief it accepts against");
      break;
    default:
      break;
  }
  checkData(fact);
}

const KIND_RANK: ReadonlyMap<FactKind, number> = new Map(FACT_KINDS.map((kind, index) => [kind, index]));

/**
 * The canonical order of facts: item revision, then time, then kind, then
 * dedupe key. It depends on nothing about when or how a fact arrived, so any
 * arrival order sorts the same way. The dedupe key is unique per item, which
 * makes the order total.
 */
export function compareFacts(a: WorkFact, b: WorkFact): number {
  if (a.itemRevision !== b.itemRevision) return a.itemRevision - b.itemRevision;
  const time = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
  if (time !== 0) return time;
  const rank = (KIND_RANK.get(a.kind) ?? 0) - (KIND_RANK.get(b.kind) ?? 0);
  if (rank !== 0) return rank;
  return a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0;
}

/** A sorted copy of the facts in canonical order. Pure. */
export function sortFacts<T extends WorkFact>(facts: readonly T[]): T[] {
  return [...facts].sort(compareFacts);
}

/**
 * The idempotency key of a send: the item, the brief revision, and the send
 * number, fixed before the send leaves. A retry reuses it, and a send on an
 * older brief revision cannot come back with a key the current brief issues.
 */
export function workOrderKey(item: string, briefRevision: number, send: number): string {
  return `${item}:r${briefRevision}:s${send}`;
}
