// The Work view models (agent-work-phase-1.html, Screens; roadmap
// mockups/pages/work.md, work-item.md, work-setup.md, work-outcomes.md):
// the work items the Work page lists, one work item with everything a person
// decides on, the agents that can take a send, the outcome measures, and the
// collectors and priorities record Work setup shows.
//
// Every field is read from the work records through the kernel
// (list_work_items, get_work_item, list_work_targets, get_work_outcomes,
// list_work_collectors, get_work_priorities). The server decides each item's
// status and what it waits for; the page maps each code to its own words. A
// field is nullable exactly where the record may not hold it (§3.4): a cost a
// run never reported is null, never zero.
//
// Source text (an issue's title, description, labels, a requester) comes from
// outside the workspace. The page renders it as text and nothing treats it
// as an instruction.
import { z } from "zod";
import { PublicId } from "./common";
import { Cost, Money } from "./money";

const Instant = z.iso.datetime({ offset: true });
const Count = z.number().int().nonnegative();
const Revision = z.number().int().positive();
const Sha = z.string().regex(/^[0-9a-f]{40}$/);

export const WorkTab = z.enum(["inbox", "running", "review", "done"]);
export type WorkTab = z.infer<typeof WorkTab>;

export const WorkItemState = z.enum([
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
]);
export type WorkItemState = z.infer<typeof WorkItemState>;

/** The word beside an item's dot, decided on the server. */
export const WorkStatus = z.enum([
  "triaging",
  "triage_failed",
  "needs_info",
  "possible_duplicate",
  "out_of_scope",
  "brief_to_approve",
  "changed",
  "ready",
  "send_rejected",
  "waiting_for_claim",
  "no_answer",
  "running",
  "stopping",
  "in_review",
  "accepted",
  "done",
  "closed",
]);
export type WorkStatus = z.infer<typeof WorkStatus>;

export const WorkPriorityLabel = z.enum(["P0", "P1", "P2", "P3"]);
export type WorkPriorityLabel = z.infer<typeof WorkPriorityLabel>;

export const RuntimeTier = z.enum(["contained", "gateway", "harness", "observe"]);
export type RuntimeTier = z.infer<typeof RuntimeTier>;

export const DeliveryState = z.enum([
  "waiting_for_claim",
  "claimed",
  "running",
  "stopping",
  "run_ended",
  "stopped",
  "returned",
  "withdrawn",
  "rejected",
]);
export type DeliveryState = z.infer<typeof DeliveryState>;

export const CheckConclusion = z.enum([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "neutral",
  "timed_out",
  "action_required",
  "stale",
  "pending",
]);
export type CheckConclusion = z.infer<typeof CheckConclusion>;

/** The required checks on the head commit, as one word. */
export const ChecksWord = z.enum([
  "passing",
  "failing",
  "missing",
  "running",
  "unread",
  "none_required",
  "no_pull_request",
  "pr_closed",
]);
export type ChecksWord = z.infer<typeof ChecksWord>;

export const ReviewBlock = z.enum([
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
]);
export type ReviewBlock = z.infer<typeof ReviewBlock>;

export const CloseResolution = z.enum(["cancelled", "declined", "duplicate"]);
export type CloseResolution = z.infer<typeof CloseResolution>;

/** Whether Accept is open on a send, and if not, why. */
export const ReviewGate = z.object({
  open: z.boolean(),
  block: ReviewBlock.nullable(),
  /** A check name, a head commit, or a delivery state the block names. */
  detail: z.string().nullable(),
});
export type ReviewGate = z.infer<typeof ReviewGate>;

/** What an item's runs cost: the known total and how many runs it covers. */
export const CostCoverage = z.object({
  runs: Count,
  knownRuns: Count,
  /** The sum of the runs whose cost is known. Null when none is. */
  total: Money.nullable(),
});
export type CostCoverage = z.infer<typeof CostCoverage>;

export const WorkPriority = z.object({
  label: WorkPriorityLabel.nullable(),
  by: z.enum(["oxagen", "person"]).nullable(),
  /** Triage's reason. Null when a person set the priority. */
  reason: z.string().nullable(),
  /** The priorities rules triage cited, as `<lineage>#<number>`. */
  cites: z.array(z.string()),
  /** The person who set it. */
  setBy: z.string().nullable(),
});
export type WorkPriority = z.infer<typeof WorkPriority>;

const ItemRef = z.object({ id: PublicId, number: z.string() });

/** What an item waits for, as a code and the facts its sentence names. */
export const WorkWait = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("triaging") }),
  z.object({ kind: z.literal("triage_failed"), reason: z.string() }),
  z.object({ kind: z.literal("needs_info"), question: z.string().nullable() }),
  z.object({ kind: z.literal("possible_duplicate"), of: ItemRef.nullable() }),
  z.object({ kind: z.literal("out_of_scope") }),
  z.object({
    kind: z.literal("brief_to_approve"),
    fromTriage: z.boolean(),
    reopened: z
      .object({ by: z.string().nullable(), at: Instant, reason: z.string() })
      .nullable(),
  }),
  z.object({ kind: z.literal("brief_to_write") }),
  z.object({
    kind: z.literal("changed"),
    cause: z.enum(["source", "brief"]),
    at: Instant.nullable(),
    approvedRevision: Revision.nullable(),
  }),
  z.object({
    kind: z.literal("ready"),
    lastSend: z
      .object({
        delivery: z.enum(["withdrawn", "stopped", "returned"]),
        at: Instant.nullable(),
        reason: z.string().nullable(),
      })
      .nullable(),
  }),
  z.object({
    kind: z.literal("send_rejected"),
    at: Instant.nullable(),
    reason: z.string(),
  }),
  z.object({
    kind: z.literal("waiting_for_claim"),
    runtime: z.string().nullable(),
    sentAt: Instant,
    lastPollAt: Instant.nullable(),
  }),
  z.object({
    kind: z.literal("no_answer"),
    runtime: z.string().nullable(),
    lastPollAt: Instant.nullable(),
  }),
  z.object({
    kind: z.literal("running"),
    changedSinceSend: z.boolean(),
    changedAt: Instant.nullable(),
    briefRevision: Revision,
  }),
  z.object({ kind: z.literal("stopping"), runtime: z.string().nullable() }),
  z.object({ kind: z.literal("ready_for_review"), head: Sha }),
  z.object({ kind: z.literal("no_required_checks"), head: Sha }),
  z.object({
    kind: z.literal("check_failed"),
    check: z.string(),
    conclusion: CheckConclusion,
    head: Sha,
  }),
  z.object({
    kind: z.literal("check_missing"),
    check: z.string(),
    head: Sha,
  }),
  z.object({ kind: z.literal("checks_running"), head: Sha }),
  z.object({ kind: z.literal("checks_unread"), head: Sha }),
  z.object({
    kind: z.literal("new_head"),
    head: Sha,
    earlier: Sha,
    at: Instant.nullable(),
  }),
  z.object({ kind: z.literal("no_pull_request") }),
  z.object({ kind: z.literal("no_head") }),
  z.object({ kind: z.literal("pr_closed"), at: Instant.nullable() }),
  z.object({ kind: z.literal("merged_before_review"), at: Instant }),
  z.object({ kind: z.literal("brief_out_of_date") }),
  z.object({
    kind: z.literal("accepted_waiting_merge"),
    by: z.string().nullable(),
    head: Sha,
  }),
  z.object({
    kind: z.literal("done"),
    accepted: z.object({ by: z.string().nullable(), at: Instant, head: Sha }),
    mergedAt: Instant,
  }),
  z.object({
    kind: z.literal("closed"),
    resolution: CloseResolution,
    by: z.string().nullable(),
    at: Instant,
    reason: z.string(),
  }),
]);
export type WorkWait = z.infer<typeof WorkWait>;

export const AgentRef = z.object({
  id: PublicId.nullable(),
  name: z.string().nullable(),
  harness: z.string().nullable(),
});
export type AgentRef = z.infer<typeof AgentRef>;

export const PullRequestRef = z.object({
  repository: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
  head: Sha.nullable(),
});
export type PullRequestRef = z.infer<typeof PullRequestRef>;

/** The latest send of an item, as a list row shows it. */
export const SendSummary = z.object({
  id: PublicId,
  send: z.number().int().positive(),
  key: z.string(),
  delivery: DeliveryState,
  noAnswer: z.boolean(),
  agent: AgentRef,
  runtime: z.object({ name: z.string().nullable(), tier: RuntimeTier }),
  requestedAt: Instant,
  pullRequest: PullRequestRef.nullable(),
  checks: ChecksWord,
  gate: ReviewGate,
  accepted: z.boolean(),
});
export type SendSummary = z.infer<typeof SendSummary>;

/** One work item, as the Work page's tables show it. */
export const WorkItemRow = z.object({
  id: PublicId,
  number: z.string(),
  title: z.string(),
  origin: z.enum(["provider", "email", "slack", "csv", "manual"]),
  sourceUrl: z.string().nullable(),
  repository: z.string().nullable(),
  requester: z.string().nullable(),
  labels: z.array(z.string()),
  arrivedAt: Instant,
  finishedAt: Instant.nullable(),
  state: WorkItemState,
  status: WorkStatus,
  tab: WorkTab,
  version: Count,
  revision: Revision,
  priority: WorkPriority,
  wait: WorkWait,
  send: SendSummary.nullable(),
  cost: CostCoverage,
});
export type WorkItemRow = z.infer<typeof WorkItemRow>;

/** What the viewer's roles admit, from the same check each action makes. */
export const WorkViewer = z.object({
  canControl: z.boolean(),
  canApprove: z.boolean(),
});
export type WorkViewer = z.infer<typeof WorkViewer>;

export const WorkItemList = z.object({
  items: z.array(WorkItemRow),
  truncated: z.boolean(),
  viewer: WorkViewer,
});
export type WorkItemList = z.infer<typeof WorkItemList>;

// ---- one work item --------------------------------------------------------

export const SourceRevision = z.object({
  revision: Revision,
  at: Instant,
  kind: z.enum(["collected", "entered", "changed"]),
  subject: z.string(),
  description: z.string().nullable(),
  labels: z.array(z.string()),
});
export type SourceRevision = z.infer<typeof SourceRevision>;

const TriageField = <T extends z.ZodType>(value: T) =>
  z.object({
    value: value.nullable(),
    by: z.enum(["oxagen", "person"]).nullable(),
    actor: z.string().nullable(),
    at: Instant.nullable(),
  });

export const WorkTriage = z.object({
  priority: TriageField(WorkPriorityLabel),
  priorityReason: z.string().nullable(),
  cites: z.array(z.string()),
  estimateMinutes: TriageField(Count),
  labels: TriageField(z.array(z.string())),
  claims: TriageField(z.array(z.string())),
  criteria: TriageField(z.array(z.string())),
  questions: z.array(z.string()),
  duplicates: z.array(PublicId),
  related: z.array(PublicId),
  conflicts: z.array(z.string()),
  standing: z.object({
    outcome: z
      .enum(["triaged", "needs_info", "duplicate", "out_of_scope", "failed"])
      .nullable(),
    by: z.enum(["oxagen", "person"]).nullable(),
    duplicateOf: PublicId.nullable(),
  }),
  decidedAt: Instant.nullable(),
  /** The model the decision recorded. Null when nothing recorded it. */
  model: z.string().nullable(),
  failure: z.object({ reason: z.string(), at: Instant }).nullable(),
  override: z
    .object({
      outcome: z.string(),
      reason: z.string(),
      by: z.string().nullable(),
      at: Instant,
    })
    .nullable(),
  corrections: z.array(
    z.object({
      field: z.enum([
        "priority",
        "estimate_minutes",
        "labels",
        "claims",
        "criteria",
      ]),
      before: z.union([z.string(), z.number(), z.array(z.string())]).nullable(),
      after: z.union([z.string(), z.number(), z.array(z.string())]).nullable(),
      by: z.string().nullable(),
      at: Instant,
    }),
  ),
});
export type WorkTriage = z.infer<typeof WorkTriage>;

export const BriefCriterion = z.object({
  /** The stable criterion key, such as `c3`. */
  criterion: z.string().regex(/^c[1-9][0-9]{0,5}$/),
  text: z.string(),
  tag: z.enum(["code", "test", "docs", "review"]),
  intent: z.enum(["check", "review"]),
  evidence: z.string(),
  provenance: z.enum(["source", "triage", "person"]),
});
export type BriefCriterion = z.infer<typeof BriefCriterion>;

export const BriefRevision = z.object({
  id: PublicId,
  revision: Revision,
  itemRevision: Revision,
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  repository: z.string(),
  author: z.string().nullable(),
  savedAt: Instant,
  criteria: z.array(BriefCriterion),
  approved: z.object({ by: z.string().nullable(), at: Instant }).nullable(),
});
export type BriefRevision = z.infer<typeof BriefRevision>;

export const WorkBrief = z.object({
  state: z.enum(["none", "triage_draft", "draft", "approved", "out_of_date"]),
  revisions: z.array(BriefRevision),
  triageCriteria: z.array(z.string()),
  repository: z.string().nullable(),
});
export type WorkBrief = z.infer<typeof WorkBrief>;

const Check = z.object({
  name: z.string(),
  conclusion: CheckConclusion,
  required: z.boolean(),
});
export type WorkCheck = z.infer<typeof Check>;

const Acceptance = z.object({
  head: Sha,
  by: z.string().nullable(),
  at: Instant,
  criteria: z.array(z.string()),
  requiredChecks: z.array(z.string()),
});
export type WorkAcceptance = z.infer<typeof Acceptance>;

const Reasoned = z.object({
  reason: z.string(),
  by: z.string().nullable(),
  at: Instant,
});

export const WorkRun = z.object({
  id: PublicId,
  /** Null when the run reported no usage or has not been rolled up. */
  cost: Cost.nullable(),
  tier: z.string().nullable(),
});
export type WorkRun = z.infer<typeof WorkRun>;

/** One send, with everything its review rests on. */
export const WorkSend = z.object({
  id: PublicId,
  send: z.number().int().positive(),
  key: z.string(),
  delivery: DeliveryState,
  noAnswer: z.boolean(),
  ended: z.boolean(),
  itemRevision: Revision,
  briefRevision: Revision,
  briefDigest: z.string(),
  agent: AgentRef,
  runtime: z.object({ name: z.string().nullable(), tier: RuntimeTier }),
  host: z.object({ name: z.string(), lastPollAt: Instant.nullable() }).nullable(),
  operator: z.string().nullable(),
  mandateId: PublicId.nullable(),
  requestedAt: Instant,
  deliveredAt: Instant.nullable(),
  claimedAt: Instant.nullable(),
  firstRunAt: Instant.nullable(),
  runEndedAt: Instant.nullable(),
  rejected: z.object({ reason: z.string(), at: Instant }).nullable(),
  withdrawn: Reasoned.nullable(),
  stopRequested: Reasoned.nullable(),
  stoppedAt: Instant.nullable(),
  returned: Reasoned.nullable(),
  runs: z.array(WorkRun),
  cost: CostCoverage,
  pullRequest: PullRequestRef.extend({
    headAt: Instant.nullable(),
    merged: z.object({ at: Instant, mergeCommit: Sha }).nullable(),
    closedAt: Instant.nullable(),
  }).nullable(),
  requiredChecks: z.array(z.string()).nullable(),
  checks: z.array(Check),
  earlierChecks: z.object({ head: Sha, checks: z.array(Check) }).nullable(),
  checksWord: ChecksWord,
  gate: ReviewGate,
  acceptance: Acceptance.nullable(),
  staleAcceptance: Acceptance.nullable(),
  claims: z.array(
    z.object({
      criterion: z.string(),
      text: z.string(),
      head: Sha.nullable(),
      current: z.boolean(),
    }),
  ),
});
export type WorkSend = z.infer<typeof WorkSend>;

export const WorkHistoryEntry = z.object({
  kind: z.string(),
  source: z.enum(["provider", "runtime", "agent", "person", "oxagen"]),
  actor: z.string().nullable(),
  at: Instant,
  itemRevision: Revision,
  send: z.number().int().positive().nullable(),
  reason: z.string().nullable(),
  resolution: z.string().nullable(),
  outcome: z.string().nullable(),
  head: Sha.nullable(),
  check: z.string().nullable(),
  conclusion: z.string().nullable(),
  pullRequest: z.string().nullable(),
  mergeCommit: z.string().nullable(),
  briefRevision: Revision.nullable(),
});
export type WorkHistoryEntry = z.infer<typeof WorkHistoryEntry>;

export const WorkItemDetail = z.object({
  item: WorkItemRow.extend({
    description: z.string().nullable(),
    sourceRevisions: z.array(SourceRevision),
    collector: z
      .object({
        name: z.string(),
        health: z.enum(["healthy", "lagging", "failing", "paused"]),
      })
      .nullable(),
  }),
  triage: WorkTriage,
  brief: WorkBrief,
  nextSend: z.object({ send: z.number().int().positive(), key: z.string() }).nullable(),
  /** Every send, newest first. */
  sends: z.array(WorkSend),
  history: z.array(WorkHistoryEntry),
  viewer: WorkViewer,
});
export type WorkItemDetail = z.infer<typeof WorkItemDetail>;

// ---- agents that can take a send ----------------------------------------

export const WorkTargetRefusal = z.enum([
  "no_runtime",
  "no_host",
  "host_outdated",
  "not_operator",
  "busy",
]);
export type WorkTargetRefusal = z.infer<typeof WorkTargetRefusal>;

export const WorkTarget = z.object({
  id: PublicId,
  name: z.string(),
  harness: z.string(),
  runtime: z
    .object({ id: PublicId, name: z.string(), tier: RuntimeTier })
    .nullable(),
  host: z
    .object({
      name: z.string(),
      lastPollAt: Instant.nullable(),
      takesWorkOrders: z.boolean(),
    })
    .nullable(),
  operates: z.boolean(),
  busyWith: ItemRef.nullable(),
  canTake: z.boolean(),
  reason: WorkTargetRefusal.nullable(),
  quiet: z.boolean(),
});
export type WorkTarget = z.infer<typeof WorkTarget>;

export const WorkTargetList = z.object({ agents: z.array(WorkTarget) });
export type WorkTargetList = z.infer<typeof WorkTargetList>;

// ---- outcomes ---------------------------------------------------------------

export const WorkOutcomes = z.object({
  days: z.number().int().positive(),
  since: Instant,
  acceptedMerged: Count,
  returned: Count,
  closed: z.object({ cancelled: Count, declined: Count, duplicate: Count }),
  leadTime: z.object({
    medianHours: z.number().nonnegative().nullable(),
    p90Hours: z.number().nonnegative().nullable(),
    sample: Count,
  }),
  touches: z.object({
    perItem: z.number().nonnegative().nullable(),
    briefApprovals: Count,
    acceptances: Count,
    returns: Count,
    triageOverrides: Count,
    triageCorrections: Count,
  }),
  cost: CostCoverage,
  reopens: z.object({ cohort: Count, reopened: Count, waiting: Count }),
  weeks: z.array(
    z.object({
      week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      acceptedMerged: Count,
      returned: Count,
      medianLeadHours: z.number().nonnegative().nullable(),
    }),
  ),
});
export type WorkOutcomes = z.infer<typeof WorkOutcomes>;

// ---- setup: collectors and priorities ---------------------------------------

export const WorkCollector = z.object({
  /** The collector's row reference, which sync_work_collector names. Not a public id. */
  collectorRef: z.string().uuid(),
  name: z.string(),
  type: z.literal("github"),
  connectionId: PublicId.nullable(),
  repos: z.array(z.string()),
  health: z.enum(["healthy", "lagging", "failing", "paused"]),
  cursor: z.string().nullable(),
  lastReconcile: z
    .object({
      at: Instant,
      ok: z.boolean(),
      pages: Count,
      handled: Count,
      missed: Count,
      error: z.string().nullable(),
    })
    .nullable(),
  lastSuccessAt: Instant.nullable(),
  failedStreak: Count,
  nextCheckAt: Instant.nullable(),
  lastEventAt: Instant.nullable(),
  createdAt: Instant,
});
export type WorkCollector = z.infer<typeof WorkCollector>;

export const WorkCollectorList = z.object({
  collectors: z.array(WorkCollector),
});
export type WorkCollectorList = z.infer<typeof WorkCollectorList>;

export const WorkPriorities = z.object({
  record: z
    .object({
      lineage: z.string(),
      version: z.number().int().positive(),
      hash: z.string(),
      rules: z.array(
        z.object({ number: z.number().int().nonnegative(), text: z.string() }),
      ),
      publishedAt: Instant.nullable(),
    })
    .nullable(),
  /** Why triage cannot rank work, or null when the record is in place. */
  problem: z.string().nullable(),
  last30Days: z.object({
    suggestions: Count,
    failures: Count,
    corrections: Count,
  }),
});
export type WorkPriorities = z.infer<typeof WorkPriorities>;
