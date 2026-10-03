// get_work_item output to the Work item view model (ARCHITECTURE.md §3.4).
// Typed from the contract's `_output`. Every value is copied and renamed:
// the source revisions, triage with its corrections, every brief revision,
// every send with its runs, pull request, checks, and acceptance, and the
// history. A run's cost the record does not hold stays null, and its basis
// is the rollup's own value or null (INV-10).
import type { workItemGet } from "@oxagen/oxagen/contracts/work.item.get";
import type { z } from "zod";
import type { WorkItemDetail, WorkRun, WorkSend } from "@/data/contracts/work";
import type { ContractOutput } from "@/server/kernel";
import { toCost, toForgePullRequest, toMoney, toViewer, toWorkItemRow } from "./work-list";

type ItemOut = ContractOutput<typeof workItemGet>;
type SendOut = ItemOut["sends"][number];
type RunOut = SendOut["runs"][number];
type AcceptanceOut = NonNullable<SendOut["acceptance"]>;
type CheckOut = SendOut["checks"][number];

const BASES = ["gateway_observed", "client_attested", "mixed", "estimated"] as const;
type Basis = (typeof BASES)[number];

/** The rollup's basis when it is one the view knows, else null: an unknown basis is not a claim. */
function knownBasis(basis: string | null): Basis | null {
  return BASES.find((entry) => entry === basis) ?? null;
}

function toRun(run: RunOut): z.input<typeof WorkRun> {
  return {
    id: run.id,
    cost: run.cost === null ? null : { ...toMoney(run.cost), basis: knownBasis(run.basis) },
    tier: run.tier,
  };
}

function toAcceptance(acceptance: AcceptanceOut) {
  return {
    head: acceptance.head,
    by: acceptance.by,
    at: acceptance.at,
    criteria: [...acceptance.criteria],
    requiredChecks: [...acceptance.required_checks],
  };
}

function toCheck(check: CheckOut) {
  return { name: check.name, conclusion: check.conclusion, required: check.required };
}

function reasoned(value: { reason: string; by: string | null; at: string } | null) {
  return value === null ? null : { reason: value.reason, by: value.by, at: value.at };
}

function toSend(send: SendOut): z.input<typeof WorkSend> {
  return {
    id: send.id,
    send: send.send,
    key: send.key,
    delivery: send.delivery,
    noAnswer: send.no_answer,
    ended: send.ended,
    itemRevision: send.item_revision,
    briefRevision: send.brief_revision,
    briefDigest: send.brief_digest,
    agent: { id: send.agent.id, name: send.agent.name, harness: send.agent.harness },
    runtime: { name: send.runtime.name, tier: send.runtime.tier },
    host: send.host === null ? null : { name: send.host.name, lastPollAt: send.host.last_poll_at },
    operator: send.operator,
    mandateId: send.mandate_id,
    requestedAt: send.requested_at,
    deliveredAt: send.delivered_at,
    claimedAt: send.claimed_at,
    firstRunAt: send.first_run_at,
    runEndedAt: send.run_ended_at,
    rejected: send.rejected === null ? null : { reason: send.rejected.reason, at: send.rejected.at },
    withdrawn: reasoned(send.withdrawn),
    stopRequested: reasoned(send.stop_requested),
    stoppedAt: send.stopped_at,
    returned: reasoned(send.returned),
    runs: send.runs.map(toRun),
    cost: toCost(send.cost),
    pullRequest:
      send.pull_request === null
        ? null
        : {
            repository: send.pull_request.repository,
            number: send.pull_request.number,
            url: send.pull_request.url,
            head: send.pull_request.head,
            headAt: send.pull_request.head_at,
            merged:
              send.pull_request.merged === null
                ? null
                : { at: send.pull_request.merged.at, mergeCommit: send.pull_request.merged.merge_commit },
            closedAt: send.pull_request.closed_at,
          },
    pullRequests: send.pull_requests.map(toForgePullRequest),
    requiredChecks: send.required_checks === null ? null : [...send.required_checks],
    checks: send.checks.map(toCheck),
    earlierChecks:
      send.earlier_checks === null
        ? null
        : { head: send.earlier_checks.head, checks: send.earlier_checks.checks.map(toCheck) },
    checksWord: send.checks_word,
    gate: { open: send.gate.open, block: send.gate.block, detail: send.gate.detail },
    acceptance: send.acceptance === null ? null : toAcceptance(send.acceptance),
    staleAcceptance: send.stale_acceptance === null ? null : toAcceptance(send.stale_acceptance),
    claims: send.claims.map((claim) => ({
      criterion: claim.criterion,
      text: claim.text,
      head: claim.head,
      current: claim.current,
    })),
  };
}

export function toWorkItemDetail(out: ItemOut): z.input<typeof WorkItemDetail> {
  const triage = out.triage;
  const view = triage.view;
  const field = <T,>(entry: { value: T | null; by: "oxagen" | "person" | null; actor: string | null; at: string | null }) => ({
    value: entry.value,
    by: entry.by,
    actor: entry.actor,
    at: entry.at,
  });
  return {
    item: {
      ...toWorkItemRow(out.item),
      description: out.item.description,
      sourceRevisions: out.item.source_revisions.map((revision) => ({
        revision: revision.revision,
        at: revision.at,
        kind: revision.kind,
        subject: revision.subject,
        description: revision.description,
        labels: [...revision.labels],
      })),
      collector:
        out.item.collector === null ? null : { name: out.item.collector.name, health: out.item.collector.health },
    },
    triage: {
      priority: field(view.priority),
      priorityReason: view.priority_reason,
      cites: [...view.cites],
      estimateMinutes: field(view.estimate_minutes),
      labels: field(view.labels),
      claims: field(view.claims),
      criteria: field(view.criteria),
      questions: [...view.questions],
      duplicates: [...view.duplicates],
      related: [...view.related],
      conflicts: [...view.conflicts],
      standing: {
        outcome: triage.standing.outcome,
        by: triage.standing.by,
        duplicateOf: triage.standing.duplicate_of,
      },
      decidedAt: triage.decided_at,
      model: triage.model,
      failure: triage.failure === null ? null : { reason: triage.failure.reason, at: triage.failure.at },
      override:
        triage.override === null
          ? null
          : {
              outcome: triage.override.outcome,
              reason: triage.override.reason,
              by: triage.override.by,
              at: triage.override.at,
            },
      corrections: triage.corrections.map((correction) => ({
        field: correction.field,
        before: correction.before,
        after: correction.after,
        by: correction.by,
        at: correction.at,
      })),
    },
    brief: {
      state: out.brief.state,
      revisions: out.brief.revisions.map((brief) => ({
        id: brief.id,
        revision: brief.revision,
        itemRevision: brief.item_revision,
        digest: brief.digest,
        repository: brief.repository,
        author: brief.author,
        savedAt: brief.saved_at,
        criteria: brief.criteria.map((criterion) => ({
          criterion: criterion.criterion,
          text: criterion.text,
          tag: criterion.tag,
          intent: criterion.intent,
          evidence: criterion.evidence,
          provenance: criterion.provenance,
        })),
        approved: brief.approved === null ? null : { by: brief.approved.by, at: brief.approved.at },
      })),
      triageCriteria: [...out.brief.triage_criteria],
      repository: out.brief.repository,
    },
    nextSend: out.next_send === null ? null : { send: out.next_send.send, key: out.next_send.key },
    sends: out.sends.map(toSend),
    history: out.history.map((entry) => ({
      kind: entry.kind,
      source: entry.source,
      actor: entry.actor,
      at: entry.at,
      itemRevision: entry.item_revision,
      send: entry.send,
      reason: entry.reason,
      resolution: entry.resolution,
      outcome: entry.outcome,
      head: entry.head,
      check: entry.check,
      conclusion: entry.conclusion,
      pullRequest: entry.pull_request,
      mergeCommit: entry.merge_commit,
      briefRevision: entry.brief_revision,
    })),
    viewer: toViewer(out.viewer),
  };
}
