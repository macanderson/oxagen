// test-fixtures.ts: fact builders the record tests share. Test support only:
// no production module imports it, and coverage leaves it out.
import type { Sha256Digest } from "@oxagen/run-evidence";
import { type CheckConclusion, type WorkFact, newFact } from "./facts";

export const SHA1 = "1".repeat(40);
export const SHA2 = "2".repeat(40);
export const MERGE = "9".repeat(40);

export function digest(n: number): Sha256Digest {
  return `sha256:${String(n).padStart(64, "0")}`;
}

/** Minutes after 10:00 UTC on 2026-10-01. */
export function at(minute: number): string {
  return new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString();
}

const snapshot = (n: number) => ({ digest: digest(100 + n), subject: `Fix invites ${n}`, description: null, labels: [] });

export const f = {
  collected: () =>
    newFact({ kind: "collected", source: "provider", itemRevision: 1, actor: "github", occurredAt: at(0), dedupeKey: "collected", data: snapshot(1) }),
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
  triage: (outcome: "triaged" | "needs_info" | "duplicate" | "out_of_scope", minute = 1, revision = 1) =>
    newFact({
      kind: "triage_recorded",
      source: "oxagen",
      itemRevision: revision,
      actor: "triage",
      occurredAt: at(minute),
      dedupeKey: `triage:${minute}`,
      data: { decision: `tri_${minute}`, outcome, duplicate_of: outcome === "duplicate" ? "wi_other" : null },
    }),
  triageFailed: (minute = 1) =>
    newFact({ kind: "triage_failed", source: "oxagen", itemRevision: 1, actor: "triage", occurredAt: at(minute), dedupeKey: `triage-failed:${minute}`, data: { reason: "The output did not parse." } }),
  override: (outcome: "triaged" | "duplicate" | null, minute: number) =>
    newFact({ kind: "triage_overridden", source: "person", itemRevision: 1, actor: "amara", occurredAt: at(minute), dedupeKey: `override:${minute}`, data: { outcome, duplicate_of: null, reason: "Checked by hand." } }),
  saved: (revision: number, itemRevision: number, minute: number, revises = false) =>
    newFact({
      kind: "brief_saved",
      source: "person",
      itemRevision,
      actor: "amara",
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
      actor: "marcus",
      occurredAt: at(minute),
      dedupeKey: `approve:${revision}`,
      briefId: `brief-${revision}`,
      briefDigest: digest(revision),
      data: { revision },
    }),
  send: (order: string, send: number, briefRevision: number, itemRevision: number, minute: number) =>
    newFact({
      kind: "send_requested",
      source: "person",
      itemRevision,
      actor: "marcus",
      occurredAt: at(minute),
      dedupeKey: `send:${order}`,
      orderId: order,
      briefId: `brief-${briefRevision}`,
      briefDigest: digest(briefRevision),
      data: {
        send,
        brief_revision: briefRevision,
        key: `wi_x:r${briefRevision}:s${send}`,
        agent_id: "agent-1",
        runtime_id: "runtime-1",
        runtime_tier: "gateway",
        operator_id: "marcus",
      },
    }),
  runtime: (kind: "claimed" | "run_linked" | "run_ended" | "stopped", order: string, minute: number, itemRevision = 1) => {
    const common = { source: "runtime" as const, itemRevision, actor: "tch_runner", occurredAt: at(minute), dedupeKey: `${kind}:${order}`, orderId: order };
    if (kind === "claimed") return newFact({ kind, ...common, data: { host: "tch_runner" } });
    if (kind === "run_linked") return newFact({ kind, ...common, runId: "tse_run1", data: {} });
    if (kind === "run_ended") return newFact({ kind, ...common, runId: "tse_run1", data: { outcome: "stopped" } });
    return newFact({ kind, ...common, data: {} });
  },
  rejected: (order: string, minute: number) =>
    newFact({ kind: "send_rejected", source: "runtime", itemRevision: 1, actor: "tch_runner", occurredAt: at(minute), dedupeKey: `rejected:${order}`, orderId: order, data: { reason: "Signed out." } }),
  withdrawn: (order: string, minute: number) =>
    newFact({ kind: "send_withdrawn", source: "person", itemRevision: 1, actor: "marcus", occurredAt: at(minute), dedupeKey: `withdrawn:${order}`, orderId: order, data: { reason: "Wrong agent." } }),
  stopRequested: (order: string, minute: number) =>
    newFact({ kind: "stop_requested", source: "person", itemRevision: 1, actor: "marcus", occurredAt: at(minute), dedupeKey: `stop:${order}`, orderId: order, data: { reason: "Scope changed." } }),
  prLinked: (order: string, minute: number) =>
    newFact({ kind: "pr_linked", source: "runtime", itemRevision: 1, actor: "tch_runner", occurredAt: at(minute), dedupeKey: `pr:${order}`, orderId: order, repository: "aintel/platform", prNumber: 612, data: {} }),
  head: (order: string, sha: string, minute: number, itemRevision = 1) =>
    newFact({ kind: "head_observed", source: "provider", itemRevision, actor: "github", occurredAt: at(minute), dedupeKey: `head:${order}:${sha}`, orderId: order, repository: "aintel/platform", prNumber: 612, headSha: sha, data: {} }),
  required: (order: string, sha: string, names: string[], minute: number) =>
    newFact({ kind: "checks_required", source: "provider", itemRevision: 1, actor: "github", occurredAt: at(minute), dedupeKey: `required:${order}:${sha}:${minute}`, orderId: order, headSha: sha, data: { names } }),
  check: (order: string, sha: string, name: string, conclusion: CheckConclusion, minute: number) =>
    newFact({ kind: "check_observed", source: "provider", itemRevision: 1, actor: "github", occurredAt: at(minute), dedupeKey: `check:${order}:${sha}:${name}:${minute}`, orderId: order, headSha: sha, data: { name, conclusion } }),
  claim: (order: string, criterion: string, sha: string | null, minute: number) =>
    newFact({ kind: "criterion_claimed", source: "agent", itemRevision: 1, actor: "agent-1", occurredAt: at(minute), dedupeKey: `claim:${order}:${criterion}:${minute}`, orderId: order, criterionId: criterion, headSha: sha, data: { text: "Covered by a test." } }),
  accepted: (order: string, sha: string, briefRevision: number, minute: number, itemRevision = 1) =>
    newFact({ kind: "accepted", source: "person", itemRevision, actor: "marcus", occurredAt: at(minute), dedupeKey: `accept:${order}:${sha}`, orderId: order, headSha: sha, briefDigest: digest(briefRevision), data: { criteria: ["c1"], required_checks: ["test"] } }),
  returned: (order: string, minute: number) =>
    newFact({ kind: "returned", source: "person", itemRevision: 1, actor: "marcus", occurredAt: at(minute), dedupeKey: `returned:${order}`, orderId: order, data: { reason: "The test is missing." } }),
  merged: (order: string, sha: string, minute: number) =>
    newFact({ kind: "merged", source: "provider", itemRevision: 1, actor: "github", occurredAt: at(minute), dedupeKey: `merged:${order}`, orderId: order, headSha: sha, data: { merge_commit: MERGE } }),
  prClosed: (order: string, minute: number) =>
    newFact({ kind: "pr_closed", source: "provider", itemRevision: 1, actor: "github", occurredAt: at(minute), dedupeKey: `pr-closed:${order}`, orderId: order, data: {} }),
  closed: (itemRevision: number, minute: number) =>
    newFact({ kind: "closed", source: "person", itemRevision, actor: "marcus", occurredAt: at(minute), dedupeKey: `closed:${minute}`, data: { resolution: "declined", reason: "Not this quarter." } }),
  reopened: (itemRevision: number, afterSend: number, minute: number) =>
    newFact({ kind: "reopened", source: "person", itemRevision, actor: "amara", occurredAt: at(minute), dedupeKey: `reopened:${minute}`, data: { reason: "The bug came back.", after_send: afterSend } }),
};

/** Triaged, brief revision 1 approved on item revision 1. */
export const READY: WorkFact[] = [f.collected(), f.triage("triaged"), f.saved(1, 1, 2), f.approved(1, 1, 3)];

/** Ready, sent, claimed, run ended, a pull request with head SHA1 and a passing required check. */
export const IN_REVIEW: WorkFact[] = [
  ...READY,
  f.send("o1", 1, 1, 1, 4),
  f.runtime("claimed", "o1", 5),
  f.runtime("run_linked", "o1", 6),
  f.prLinked("o1", 7),
  f.head("o1", SHA1, 8),
  f.runtime("run_ended", "o1", 9),
  f.required("o1", SHA1, ["test"], 10),
  f.check("o1", SHA1, "test", "success", 11),
];
