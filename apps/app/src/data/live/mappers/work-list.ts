// The Work reads' output to the Work view models (ARCHITECTURE.md §3.4):
// list_work_items, list_work_targets, get_work_outcomes,
// list_work_collectors and get_work_priorities, and the row, wait, send, and
// cost pieces get_work_item shares (./work-item.ts).
//
// Typed from each contract's `_output`. The mapping renames the wire's
// snake_case to the view's camelCase and copies every value: a cost the
// record does not hold stays null and nothing is invented, and a tier comes
// from the contract field (INV-10).
import type { workCollectorsList } from "@oxagen/oxagen/contracts/work.collectors.list";
import type { workItemsList } from "@oxagen/oxagen/contracts/work.items.list";
import type { workOutcomesGet } from "@oxagen/oxagen/contracts/work.outcomes.get";
import type { workPrioritiesGet } from "@oxagen/oxagen/contracts/work.priorities.get";
import type { workTargetsList } from "@oxagen/oxagen/contracts/work.targets.list";
import type { z } from "zod";
import { type Money, moneyFromMicros } from "@/data/contracts/money";
import type {
  CostCoverage,
  SendSummary,
  WorkCollectorList,
  WorkItemList,
  WorkItemRow,
  WorkOutcomes,
  WorkPriorities,
  WorkPriority,
  WorkTargetList,
  WorkViewer,
  WorkWait,
} from "@/data/contracts/work";
import type { ContractOutput } from "@/server/kernel";

type ListOut = ContractOutput<typeof workItemsList>;
type RowOut = ListOut["items"][number];
type WaitOut = RowOut["wait"];
type SendOut = NonNullable<RowOut["send"]>;
type CostOut = RowOut["cost"];
type MoneyOut = NonNullable<CostOut["total"]>;

/** Money as the record holds it, in canonical form. */
export function toMoney(money: MoneyOut): z.input<typeof Money> {
  return moneyFromMicros(money.micros, money.currency);
}

export function toCost(cost: CostOut): z.input<typeof CostCoverage> {
  return {
    runs: cost.runs,
    knownRuns: cost.known_runs,
    total: cost.total === null ? null : toMoney(cost.total),
  };
}

function toPriority(priority: RowOut["priority"]): z.input<typeof WorkPriority> {
  return {
    label: priority.label,
    by: priority.by,
    reason: priority.reason,
    cites: [...priority.cites],
    setBy: priority.set_by,
  };
}

/** One wait, renamed. Each kind carries its own facts. */
function toWait(wait: WaitOut): z.input<typeof WorkWait> {
  switch (wait.kind) {
    case "triaging":
    case "out_of_scope":
    case "brief_to_write":
    case "no_pull_request":
    case "no_head":
    case "brief_out_of_date":
      return { kind: wait.kind };
    case "triage_failed":
      return { kind: wait.kind, reason: wait.reason };
    case "needs_info":
      return { kind: wait.kind, question: wait.question };
    case "possible_duplicate":
      return { kind: wait.kind, of: wait.of === null ? null : { id: wait.of.id, number: wait.of.number } };
    case "brief_to_approve":
      return {
        kind: wait.kind,
        fromTriage: wait.from_triage,
        reopened:
          wait.reopened === null
            ? null
            : { by: wait.reopened.by, at: wait.reopened.at, reason: wait.reopened.reason },
      };
    case "changed":
      return {
        kind: wait.kind,
        cause: wait.cause,
        at: wait.at,
        approvedRevision: wait.approved_revision,
      };
    case "ready":
      return {
        kind: wait.kind,
        lastSend:
          wait.last_send === null
            ? null
            : { delivery: wait.last_send.delivery, at: wait.last_send.at, reason: wait.last_send.reason },
      };
    case "send_rejected":
      return { kind: wait.kind, at: wait.at, reason: wait.reason };
    case "waiting_for_claim":
      return { kind: wait.kind, runtime: wait.runtime, sentAt: wait.sent_at, lastPollAt: wait.last_poll_at };
    case "no_answer":
      return { kind: wait.kind, runtime: wait.runtime, lastPollAt: wait.last_poll_at };
    case "running":
      return {
        kind: wait.kind,
        changedSinceSend: wait.changed_since_send,
        changedAt: wait.changed_at,
        briefRevision: wait.brief_revision,
      };
    case "stopping":
      return { kind: wait.kind, runtime: wait.runtime };
    case "ready_for_review":
    case "no_required_checks":
    case "checks_running":
    case "checks_unread":
      return { kind: wait.kind, head: wait.head };
    case "check_failed":
      return { kind: wait.kind, check: wait.check, conclusion: wait.conclusion, head: wait.head };
    case "check_missing":
      return { kind: wait.kind, check: wait.check, head: wait.head };
    case "new_head":
      return { kind: wait.kind, head: wait.head, earlier: wait.earlier, at: wait.at };
    case "pr_closed":
      return { kind: wait.kind, at: wait.at };
    case "merged_before_review":
      return { kind: wait.kind, at: wait.at };
    case "accepted_waiting_merge":
      return { kind: wait.kind, by: wait.by, head: wait.head };
    case "done":
      return { kind: wait.kind, accepted: { by: wait.accepted.by, at: wait.accepted.at }, mergedAt: wait.merged_at };
    case "closed":
      return { kind: wait.kind, resolution: wait.resolution, by: wait.by, at: wait.at, reason: wait.reason };
  }
}

function toSendSummary(send: SendOut): z.input<typeof SendSummary> {
  return {
    id: send.id,
    send: send.send,
    key: send.key,
    delivery: send.delivery,
    noAnswer: send.no_answer,
    agent: { id: send.agent.id, name: send.agent.name, harness: send.agent.harness },
    runtime: { name: send.runtime.name, tier: send.runtime.tier },
    requestedAt: send.requested_at,
    pullRequest:
      send.pull_request === null
        ? null
        : {
            repository: send.pull_request.repository,
            number: send.pull_request.number,
            url: send.pull_request.url,
            head: send.pull_request.head,
          },
    checks: send.checks,
    gate: { open: send.gate.open, block: send.gate.block, detail: send.gate.detail },
    accepted: send.accepted,
  };
}

export function toWorkItemRow(row: RowOut): z.input<typeof WorkItemRow> {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    origin: row.origin,
    sourceUrl: row.source_url,
    repository: row.repository,
    requester: row.requester,
    labels: [...row.labels],
    arrivedAt: row.arrived_at,
    finishedAt: row.finished_at,
    state: row.state,
    status: row.status,
    tab: row.tab,
    version: row.version,
    revision: row.revision,
    priority: toPriority(row.priority),
    wait: toWait(row.wait),
    send: row.send === null ? null : toSendSummary(row.send),
    cost: toCost(row.cost),
  };
}

export function toViewer(viewer: ListOut["viewer"]): z.input<typeof WorkViewer> {
  return { canControl: viewer.can_control, canApprove: viewer.can_approve };
}

export function toWorkItemList(out: ListOut): z.input<typeof WorkItemList> {
  return {
    items: out.items.map(toWorkItemRow),
    truncated: out.truncated,
    viewer: toViewer(out.viewer),
  };
}

export function toWorkTargetList(
  out: ContractOutput<typeof workTargetsList>,
): z.input<typeof WorkTargetList> {
  return {
    agents: out.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      harness: agent.harness,
      runtime:
        agent.runtime === null
          ? null
          : { id: agent.runtime.id, name: agent.runtime.name, tier: agent.runtime.tier },
      host:
        agent.host === null
          ? null
          : {
              name: agent.host.name,
              lastPollAt: agent.host.last_poll_at,
              takesWorkOrders: agent.host.takes_work_orders,
            },
      operates: agent.operates,
      busyWith: agent.busy_with === null ? null : { id: agent.busy_with.id, number: agent.busy_with.number },
      canTake: agent.can_take,
      reason: agent.reason,
      quiet: agent.quiet,
    })),
  };
}

export function toWorkOutcomes(
  out: ContractOutput<typeof workOutcomesGet>,
): z.input<typeof WorkOutcomes> {
  return {
    days: out.days,
    since: out.since,
    acceptedMerged: out.accepted_merged,
    returned: out.returned,
    closed: {
      cancelled: out.closed.cancelled,
      declined: out.closed.declined,
      duplicate: out.closed.duplicate,
    },
    leadTime: {
      medianHours: out.lead_time.median_hours,
      p90Hours: out.lead_time.p90_hours,
      sample: out.lead_time.sample,
    },
    touches: {
      perItem: out.touches.per_item,
      briefApprovals: out.touches.brief_approvals,
      acceptances: out.touches.acceptances,
      returns: out.touches.returns,
      triageOverrides: out.touches.triage_overrides,
      triageCorrections: out.touches.triage_corrections,
    },
    cost: toCost(out.cost),
    reopens: {
      cohort: out.reopens.cohort,
      reopened: out.reopens.reopened,
      waiting: out.reopens.waiting,
    },
    weeks: out.weeks.map((week) => ({
      week: week.week,
      acceptedMerged: week.accepted_merged,
      returned: week.returned,
      medianLeadHours: week.median_lead_hours,
    })),
  };
}

export function toWorkCollectorList(
  out: ContractOutput<typeof workCollectorsList>,
): z.input<typeof WorkCollectorList> {
  return {
    collectors: out.collectors.map((collector) => ({
      collectorRef: collector.collector_id,
      name: collector.name,
      type: collector.type,
      connectionId: collector.connection_id,
      repos: [...collector.repos],
      health: collector.health,
      cursor: collector.cursor,
      lastReconcile:
        collector.last_reconcile === null
          ? null
          : {
              at: collector.last_reconcile.at,
              ok: collector.last_reconcile.ok,
              pages: collector.last_reconcile.pages,
              handled: collector.last_reconcile.handled,
              missed: collector.last_reconcile.missed,
              error: collector.last_reconcile.error,
            },
      lastSuccessAt: collector.last_success_at,
      failedStreak: collector.failed_streak,
      nextCheckAt: collector.next_check_at,
      lastEventAt: collector.last_event_at,
      createdAt: collector.created_at,
    })),
  };
}

export function toWorkPriorities(
  out: ContractOutput<typeof workPrioritiesGet>,
): z.input<typeof WorkPriorities> {
  return {
    record:
      out.record === null
        ? null
        : {
            lineage: out.record.lineage,
            version: out.record.version,
            hash: out.record.hash,
            rules: out.record.rules.map((rule) => ({ number: rule.number, text: rule.text })),
            publishedAt: out.record.published_at,
          },
    problem: out.problem,
    last30Days: {
      suggestions: out.last_30_days.suggestions,
      failures: out.last_30_days.failures,
      corrections: out.last_30_days.corrections,
    },
  };
}
