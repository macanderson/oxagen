// facts.test-support.ts: fact builders and lookups the Work read tests share. Test
// support only: no production module imports it.
//
// @oxagen/work/records keeps its own fixtures out of its exports map, so these
// build facts with newFact the same way. Times are minutes after 10:00 UTC on
// 2026-10-01, and each person and row is a fixed uuid.
import type { Sha256Digest } from "@oxagen/run-evidence";
import { type TriageCorrection, type TriageDecision, effectiveTriage } from "@oxagen/work";
import { type CheckConclusion, type CloseResolution, type MergedBy, type WorkFact, newFact, reduceWorkItem } from "@oxagen/work/records";
import type { OrderPullRequest } from "../forge-pull-requests/orders";
import type { DerivedItem, Lookups } from "./derive";

export const SHA1 = "1".repeat(40);
export const SHA2 = "2".repeat(40);
export const MERGE = "9".repeat(40);
export const REPOSITORY = "aintel/platform";

/** The operator: he sends and accepts. */
export const MARCUS = "00000000-0000-4000-8000-0000000000a1";
/** The reviewer: she writes and approves briefs. */
export const AMARA = "00000000-0000-4000-8000-0000000000a2";
export const AGENT = "00000000-0000-4000-8000-0000000000b1";
export const RUNTIME = "00000000-0000-4000-8000-0000000000b2";
export const O1 = "00000000-0000-4000-8000-0000000000c1";
export const O2 = "00000000-0000-4000-8000-0000000000c2";
export const ITEM = "wi_x";

/** A person who merges on GitHub. */
export const PERSON_MERGER: MergedBy = { login: "amara", type: "User", oxagen_app: false };
/** The Oxagen GitHub App, merging with the installation token Oxagen issues an agent. */
export const APP_MERGER: MergedBy = { login: "oxagen-connect[bot]", type: "Bot", oxagen_app: true };
/** GitHub's merge queue, merging a pull request a person queued. */
export const QUEUE_MERGER: MergedBy = { login: "github-merge-queue[bot]", type: "Bot", oxagen_app: false };

export function digest(n: number): Sha256Digest {
  return `sha256:${String(n).padStart(64, "0")}`;
}

/** Minutes after 10:00 UTC on 2026-10-01. */
export function at(minute: number): string {
  return new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString();
}

const snapshot = (n: number) => ({ digest: digest(100 + n), subject: `Fix invites ${n}`, description: null, labels: ["bug"] });

const runOf = (order: string) => `tse_${order.slice(-2)}run`;

export const f = {
  collected: (minute = 0) =>
    newFact({ kind: "collected", source: "provider", itemRevision: 1, actor: "github", occurredAt: at(minute), dedupeKey: "collected", data: snapshot(1) }),
  entered: (minute = 0) =>
    newFact({ kind: "entered", source: "person", itemRevision: 1, actor: AMARA, occurredAt: at(minute), dedupeKey: "entered", data: snapshot(1) }),
  sourceChanged: (revision: number, minute: number) =>
    newFact({
      kind: "source_changed",
      source: "provider",
      itemRevision: revision,
      actor: "github",
      occurredAt: at(minute),
      dedupeKey: `source:${revision}`,
      data: { ...snapshot(revision), previous_digest: digest(100 + revision - 1) },
    }),
  triage: (outcome: "triaged" | "needs_info" | "duplicate" | "out_of_scope", minute = 1) =>
    newFact({
      kind: "triage_recorded",
      source: "oxagen",
      itemRevision: 1,
      actor: "triage",
      occurredAt: at(minute),
      dedupeKey: `triage:${minute}`,
      data: { decision: `tri_${minute}`, outcome, duplicate_of: outcome === "duplicate" ? "wi_other" : null },
    }),
  triageFailed: (minute = 1) =>
    newFact({
      kind: "triage_failed",
      source: "oxagen",
      itemRevision: 1,
      actor: "triage",
      occurredAt: at(minute),
      dedupeKey: `triage-failed:${minute}`,
      data: { reason: "The output did not parse." },
    }),
  override: (outcome: "triaged" | "out_of_scope" | null, minute: number) =>
    newFact({
      kind: "triage_overridden",
      source: "person",
      itemRevision: 1,
      actor: AMARA,
      occurredAt: at(minute),
      dedupeKey: `override:${minute}`,
      data: { outcome, duplicate_of: null, reason: "Checked by hand." },
    }),
  saved: (revision: number, itemRevision: number, minute: number, revises = false) =>
    newFact({
      kind: "brief_saved",
      source: "person",
      itemRevision,
      actor: AMARA,
      occurredAt: at(minute),
      dedupeKey: `brief:${revision}`,
      briefId: `brief-${revision}`,
      briefDigest: digest(revision),
      data: { revision, revises },
    }),
  approved: (revision: number, itemRevision: number, minute: number) =>
    newFact({
      kind: "brief_approved",
      source: "person",
      itemRevision,
      actor: AMARA,
      occurredAt: at(minute),
      dedupeKey: `approve:${revision}:${itemRevision}`,
      briefId: `brief-${revision}`,
      briefDigest: digest(revision),
      data: { revision },
    }),
  send: (order: string, send: number, briefRevision: number, itemRevision: number, minute: number) =>
    newFact({
      kind: "send_requested",
      source: "person",
      itemRevision,
      actor: MARCUS,
      occurredAt: at(minute),
      dedupeKey: `send:${order}`,
      orderId: order,
      briefId: `brief-${briefRevision}`,
      briefDigest: digest(briefRevision),
      data: {
        send,
        brief_revision: briefRevision,
        key: `${ITEM}:r${briefRevision}:s${send}`,
        agent_id: AGENT,
        runtime_id: RUNTIME,
        runtime_tier: "gateway",
        operator_id: MARCUS,
      },
    }),
  delivered: (order: string, minute: number) =>
    newFact({
      kind: "send_delivered",
      source: "oxagen",
      itemRevision: 1,
      actor: "oxagen",
      occurredAt: at(minute),
      dedupeKey: `delivered:${order}`,
      orderId: order,
      data: { command_id: "tcm_1" },
    }),
  runtime: (kind: "claimed" | "run_linked" | "run_ended" | "stopped", order: string, minute: number) => {
    const common = { source: "runtime" as const, itemRevision: 1, actor: "tch_runner", occurredAt: at(minute), dedupeKey: `${kind}:${order}`, orderId: order };
    if (kind === "claimed") return newFact({ kind, ...common, data: { host: "tch_runner" } });
    if (kind === "run_linked") return newFact({ kind, ...common, runId: runOf(order), data: {} });
    if (kind === "run_ended") return newFact({ kind, ...common, runId: runOf(order), data: { outcome: "completed" } });
    return newFact({ kind, ...common, data: {} });
  },
  rejected: (order: string, minute: number) =>
    newFact({
      kind: "send_rejected",
      source: "runtime",
      itemRevision: 1,
      actor: "tch_runner",
      occurredAt: at(minute),
      dedupeKey: `rejected:${order}`,
      orderId: order,
      data: { reason: "Signed out." },
    }),
  withdrawn: (order: string, minute: number) =>
    newFact({
      kind: "send_withdrawn",
      source: "person",
      itemRevision: 1,
      actor: MARCUS,
      occurredAt: at(minute),
      dedupeKey: `withdrawn:${order}`,
      orderId: order,
      data: { reason: "Wrong agent." },
    }),
  stopRequested: (order: string, minute: number) =>
    newFact({
      kind: "stop_requested",
      source: "person",
      itemRevision: 1,
      actor: MARCUS,
      occurredAt: at(minute),
      dedupeKey: `stop:${order}`,
      orderId: order,
      data: { reason: "Scope changed." },
    }),
  prLinked: (order: string, minute: number) =>
    newFact({
      kind: "pr_linked",
      source: "runtime",
      itemRevision: 1,
      actor: runOf(order),
      occurredAt: at(minute),
      dedupeKey: `pr:${order}`,
      orderId: order,
      repository: REPOSITORY,
      prNumber: 612,
      data: {},
    }),
  head: (order: string, sha: string, minute: number) =>
    newFact({
      kind: "head_observed",
      source: "provider",
      itemRevision: 1,
      actor: "github",
      occurredAt: at(minute),
      dedupeKey: `head:${order}:${sha}`,
      orderId: order,
      repository: REPOSITORY,
      prNumber: 612,
      headSha: sha,
      data: {},
    }),
  required: (order: string, sha: string, names: string[], minute: number) =>
    newFact({
      kind: "checks_required",
      source: "provider",
      itemRevision: 1,
      actor: "github",
      occurredAt: at(minute),
      dedupeKey: `required:${order}:${sha}:${minute}`,
      orderId: order,
      headSha: sha,
      data: { names },
    }),
  check: (order: string, sha: string, name: string, conclusion: CheckConclusion, minute: number) =>
    newFact({
      kind: "check_observed",
      source: "provider",
      itemRevision: 1,
      actor: "github",
      occurredAt: at(minute),
      dedupeKey: `check:${order}:${sha}:${name}:${minute}`,
      orderId: order,
      headSha: sha,
      data: { name, conclusion },
    }),
  accepted: (order: string, sha: string, minute: number) =>
    newFact({
      kind: "accepted",
      source: "person",
      itemRevision: 1,
      actor: MARCUS,
      occurredAt: at(minute),
      dedupeKey: `accept:${order}:${sha}`,
      orderId: order,
      headSha: sha,
      briefDigest: digest(1),
      data: { criteria: ["c1"], required_checks: ["test"] },
    }),
  returned: (order: string, minute: number) =>
    newFact({
      kind: "returned",
      source: "person",
      itemRevision: 1,
      actor: MARCUS,
      occurredAt: at(minute),
      dedupeKey: `returned:${order}`,
      orderId: order,
      data: { reason: "The test is missing." },
    }),
  /** With no merger, the merge reads as one recorded before Oxagen read who merged. */
  merged: (order: string, sha: string, minute: number, mergedBy?: MergedBy | null) =>
    newFact({
      kind: "merged",
      source: "provider",
      itemRevision: 1,
      actor: "github",
      occurredAt: at(minute),
      dedupeKey: `merged:${order}`,
      orderId: order,
      headSha: sha,
      data: mergedBy === undefined ? { merge_commit: MERGE } : { merge_commit: MERGE, merged_by: mergedBy },
    }),
  prClosed: (order: string, minute: number) =>
    newFact({
      kind: "pr_closed",
      source: "provider",
      itemRevision: 1,
      actor: "github",
      occurredAt: at(minute),
      dedupeKey: `pr-closed:${order}`,
      orderId: order,
      data: {},
    }),
  closed: (itemRevision: number, minute: number, resolution: CloseResolution = "declined") =>
    newFact({
      kind: "closed",
      source: "person",
      itemRevision,
      actor: MARCUS,
      occurredAt: at(minute),
      dedupeKey: `closed:${minute}`,
      data: { resolution, reason: "Not this quarter." },
    }),
  reopened: (itemRevision: number, afterSend: number, minute: number) =>
    newFact({
      kind: "reopened",
      source: "person",
      itemRevision,
      actor: AMARA,
      occurredAt: at(minute),
      dedupeKey: `reopened:${minute}`,
      data: { reason: "The bug came back.", after_send: afterSend },
    }),
  /** GitHub merged pull request `number` in the same repository, which reverts the send's pull request #612. */
  reverted: (order: string, minute: number, number = 640) =>
    newFact({
      kind: "reverted",
      source: "provider",
      itemRevision: 1,
      actor: "github",
      occurredAt: at(minute),
      dedupeKey: `reverted:${order}:${REPOSITORY}#${number}`,
      orderId: order,
      repository: REPOSITORY,
      prNumber: number,
      data: { merge_commit: "4".repeat(40), reverts: 612 },
    }),
};

/** Triaged, brief revision 1 approved on item revision 1. */
export const READY: WorkFact[] = [f.collected(), f.triage("triaged"), f.saved(1, 1, 2), f.approved(1, 1, 3)];

/** Ready, then sent as send 1 (order O1). */
export const SENT: WorkFact[] = [...READY, f.send(O1, 1, 1, 1, 4)];

/** Sent, claimed, run, a pull request with head SHA1, the run ended, and a passing required check. */
export const IN_REVIEW: WorkFact[] = [
  ...SENT,
  f.runtime("claimed", O1, 5),
  f.runtime("run_linked", O1, 6),
  f.prLinked(O1, 7),
  f.head(O1, SHA1, 8),
  f.runtime("run_ended", O1, 9),
  f.required(O1, SHA1, ["test"], 10),
  f.check(O1, SHA1, "test", "success", 11),
];

/** A triage/v1 decision with drafted criteria, changed by `over`. */
export function decision(over: Partial<TriageDecision> = {}): TriageDecision {
  return {
    schema: "triage/v1",
    item: ITEM,
    state: "triaged",
    priority: { label: "P1", reason: "A paying customer is blocked.", cites: ["work.priorities#2"] },
    labels: ["bug"],
    estimate_minutes: 30,
    claims: [],
    duplicates: [],
    related: [],
    workflow: null,
    done_record: { criteria: ["An expired invite shows the expiry message."] },
    questions: [],
    conflicts: [],
    ...over,
  } as TriageDecision;
}

/** One item for the derivations: fixed columns, the facts' projection, and a triage view. */
export function item(
  facts: readonly WorkFact[],
  triage: { decision?: TriageDecision | null; corrections?: TriageCorrection[] } = {},
): DerivedItem {
  const chosen = triage.decision === undefined ? decision() : triage.decision;
  return {
    columns: {
      publicId: ITEM,
      number: "WI-7",
      title: "Fix invites",
      origin: "provider",
      sourceUrl: `https://github.com/${REPOSITORY}/issues/7`,
      repository: REPOSITORY,
      requester: "Dana",
      labels: ["bug"],
      arrivedAt: at(0),
      version: 4,
    },
    facts,
    projection: reduceWorkItem(facts),
    triage: effectiveTriage(chosen, chosen === null ? null : "tri_1", triage.corrections ?? []),
  };
}

/** Lookups that name both people, the agent, the runtime, and both sends. */
export function lookups(over: Partial<Lookups> = {}): Lookups {
  return {
    names: new Map([
      [MARCUS, "Marcus"],
      [AMARA, "Amara"],
    ]),
    items: new Map([["wi_other", { id: "wi_other", number: "WI-3" }]]),
    agents: new Map([[AGENT, { publicId: "agt_bot1", name: "Bot", harness: "claude-code" }]]),
    runtimes: new Map([[RUNTIME, { publicId: "rtm_lap1", name: "Laptop" }]]),
    orders: new Map([
      [O1, { publicId: "wo_one", mandateId: null, host: { name: "laptop-1", lastPollAt: at(30) }, commandOutcome: "queued" }],
      [O2, { publicId: "wo_two", mandateId: null, host: { name: "laptop-1", lastPollAt: at(30) }, commandOutcome: "queued" }],
    ]),
    runs: new Map(),
    pullRequests: new Map<string, readonly OrderPullRequest[]>(),
    ...over,
  };
}

/** A pull request the forge store holds for a send: #612 in the item's repository, open. */
export function forgePull(over: Partial<OrderPullRequest> = {}): OrderPullRequest {
  return {
    id: "fpr_612",
    provider: "github",
    repository: REPOSITORY,
    number: 612,
    url: `https://github.com/${REPOSITORY}/pull/612`,
    title: "Show the expiry message",
    state: "open",
    headSha: SHA1,
    stateSeenAt: at(20),
    ...over,
  };
}

/** The same lookups with send O1's command outcome replaced. */
export function withCommand(outcome: string | null): Lookups {
  const base = lookups();
  const orders = new Map(base.orders);
  orders.set(O1, { ...orders.get(O1)!, commandOutcome: outcome });
  return { ...base, orders };
}
