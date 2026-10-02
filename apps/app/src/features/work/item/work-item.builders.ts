// Typed Work item values for the Work item page's component tests
// (ARCHITECTURE.md §5): one WorkItemDetail per state the page draws, the
// agents a send can go to, and a DataSource that answers `work.get` and
// `work.targets` with what a test hands it. Every other port refuses, so a
// test that reaches for a read the page does not make fails rather than
// passing on a stub. Importable from tests only (`testOnlyTarget` in
// src/test/arch/layers.ts).
import type {
  BriefRevision,
  WorkHistoryEntry,
  WorkItemDetail,
  WorkSend,
  WorkTarget,
  WorkTargetList,
  WorkTriage,
} from "@/data/contracts/work";
import type { DataSource } from "@/data/ports";
import { type Read, readOk } from "@/data/read";

/** A full commit id that shortens to `prefix` (seven hex characters). */
function sha(prefix: string): string {
  return `${prefix}${"0".repeat(40 - prefix.length)}`;
}

/** The pull request's head commit, 3f9a2c1. */
export const HEAD = sha("3f9a2c1");
/** The head the agent's claims were made on before the pull request moved, 2d4f6a8. */
export const EARLIER_HEAD = sha("2d4f6a8");
/** The merge commit, 7c1e0b4. */
export const MERGE_COMMIT = sha("7c1e0b4");
/** The approved brief's digest. */
export const DIGEST = `sha256:${"ab12".repeat(16)}`;
/** The digest of a draft saved after the source changed. */
export const DRAFT_DIGEST = `sha256:${"cd34".repeat(16)}`;
/** The key the next send names, fixed before the first try. */
export const NEXT_KEY = "wi_12ab:r1:s1";

const ARRIVED = "2026-10-01T09:00:00Z";
const DECIDED = "2026-10-01T09:02:00Z";
const APPROVED_AT = "2026-10-01T10:00:00Z";
const SENT_AT = "2026-10-01T10:05:00Z";
const CLAIMED_AT = "2026-10-01T10:06:00Z";
const FIRST_RUN_AT = "2026-10-01T10:07:00Z";
const RUN_ENDED_AT = "2026-10-01T11:00:00Z";
const HEAD_AT = "2026-10-01T10:58:00Z";
const MERGED_AT = "2026-10-01T12:30:00Z";

type Item = WorkItemDetail["item"];

export function workItem(overrides: Partial<Item> = {}): Item {
  return {
    id: "wi_12ab",
    number: "WI-12",
    title: "Retry the export when the API answers 429",
    origin: "provider",
    sourceUrl: "https://github.com/acme/platform/issues/612",
    repository: "acme/platform",
    requester: "Amara Okafor",
    labels: ["Bug"],
    arrivedAt: ARRIVED,
    finishedAt: null,
    state: "ready",
    status: "ready",
    tab: "inbox",
    version: 4,
    revision: 1,
    priority: {
      label: "P2",
      by: "oxagen",
      reason: "A defect with a workaround.",
      cites: ["acme.work.priorities#8"],
      setBy: null,
    },
    wait: { kind: "ready", lastSend: null },
    send: null,
    cost: { runs: 0, knownRuns: 0, total: null },
    description: "The export fails when the API answers 429.\nIt should wait and retry.",
    sourceRevisions: [
      {
        revision: 1,
        at: ARRIVED,
        kind: "collected",
        subject: "Retry the export when the API answers 429",
        description: "The export fails when the API answers 429.\nIt should wait and retry.",
        labels: ["Bug"],
      },
    ],
    collector: { name: "acme-github", health: "healthy" },
    ...overrides,
  };
}

/** A triage field triage set. */
function field<T>(value: T): { value: T; by: "oxagen"; actor: null; at: string } {
  return { value, by: "oxagen", actor: null, at: DECIDED };
}

/** A triage field nothing set yet. */
function unset(): { value: null; by: null; actor: null; at: null } {
  return { value: null, by: null, actor: null, at: null };
}

export function workTriage(overrides: Partial<WorkTriage> = {}): WorkTriage {
  return {
    priority: field<"P0" | "P1" | "P2" | "P3">("P2"),
    priorityReason: "A defect with a workaround.",
    cites: ["acme.work.priorities#8"],
    estimateMinutes: field(45),
    labels: field(["Bug"]),
    claims: field(["packages/export/**"]),
    criteria: field(["The export retries after a 429.", "A test covers the retry."]),
    questions: [],
    duplicates: [],
    related: [],
    conflicts: [],
    standing: { outcome: "triaged", by: "oxagen", duplicateOf: null },
    decidedAt: DECIDED,
    model: "anthropic/claude-haiku-5",
    failure: null,
    override: null,
    corrections: [],
    ...overrides,
  };
}

/** Brief revision 1, approved for item revision 1. */
export function briefRevision(overrides: Partial<BriefRevision> = {}): BriefRevision {
  return {
    id: "wbr_1",
    revision: 1,
    itemRevision: 1,
    digest: DIGEST,
    repository: "acme/platform",
    author: "Marcus Bell",
    savedAt: "2026-10-01T09:55:00Z",
    criteria: [
      {
        criterion: "c1",
        text: "The export retries after a 429 with the Retry-After delay.",
        tag: "code",
        intent: "review",
        evidence: "The pull request diff",
        provenance: "triage",
      },
      {
        criterion: "c2",
        text: "A test covers the retry.",
        tag: "test",
        intent: "check",
        evidence: "GitHub required checks",
        provenance: "triage",
      },
    ],
    approved: { by: "Marcus Bell", at: APPROVED_AT },
    ...overrides,
  };
}

/** A send to Stella on the build box, gateway tier, still waiting for its claim. */
export function workSend(overrides: Partial<WorkSend> = {}): WorkSend {
  return {
    id: "wo_1a",
    send: 1,
    key: "wi_12ab:r1:s1",
    delivery: "waiting_for_claim",
    noAnswer: false,
    ended: false,
    itemRevision: 1,
    briefRevision: 1,
    briefDigest: DIGEST,
    agent: { id: "agt_stella", name: "Stella", harness: "stella" },
    runtime: { name: "Build box", tier: "gateway" },
    host: { name: "build-box", lastPollAt: "2026-10-01T10:04:00Z" },
    operator: "Marcus Bell",
    mandateId: "mnd_4f2a9c",
    requestedAt: SENT_AT,
    deliveredAt: null,
    claimedAt: null,
    firstRunAt: null,
    runEndedAt: null,
    rejected: null,
    withdrawn: null,
    stopRequested: null,
    stoppedAt: null,
    returned: null,
    runs: [],
    cost: { runs: 0, knownRuns: 0, total: null },
    pullRequest: null,
    requiredChecks: null,
    checks: [],
    earlierChecks: null,
    checksWord: "no_pull_request",
    gate: { open: false, block: "run_active", detail: null },
    acceptance: null,
    staleAcceptance: null,
    claims: [],
    ...overrides,
  };
}

export function historyEntry(overrides: Partial<WorkHistoryEntry> = {}): WorkHistoryEntry {
  return {
    kind: "collected",
    source: "provider",
    actor: null,
    at: ARRIVED,
    itemRevision: 1,
    send: null,
    reason: null,
    resolution: null,
    outcome: null,
    head: null,
    check: null,
    conclusion: null,
    pullRequest: null,
    mergeCommit: null,
    briefRevision: null,
    ...overrides,
  };
}

/** A ready item: brief revision 1 approved for item revision 1, not sent yet. */
export function workItemDetail(overrides: Partial<WorkItemDetail> = {}): WorkItemDetail {
  return {
    item: workItem(),
    triage: workTriage(),
    brief: {
      state: "approved",
      revisions: [briefRevision()],
      triageCriteria: [],
      repository: "acme/platform",
    },
    nextSend: { send: 1, key: NEXT_KEY },
    sends: [],
    history: [
      historyEntry(),
      historyEntry({
        kind: "triage_recorded",
        source: "oxagen",
        at: DECIDED,
        outcome: "triaged",
      }),
      historyEntry({
        kind: "brief_approved",
        source: "person",
        actor: "Marcus Bell",
        at: APPROVED_AT,
        briefRevision: 1,
      }),
    ],
    viewer: { canControl: true, canApprove: true },
    ...overrides,
  };
}

// ---- one detail per state the page draws ----------------------------------

const NO_BRIEF = {
  state: "none" as const,
  revisions: [],
  triageCriteria: [],
  repository: null,
};

export function triagingItem(): WorkItemDetail {
  return workItemDetail({
    item: workItem({
      state: "new",
      status: "triaging",
      wait: { kind: "triaging" },
      priority: { label: null, by: null, reason: null, cites: [], setBy: null },
    }),
    triage: workTriage({
      priority: unset(),
      estimateMinutes: unset(),
      labels: unset(),
      claims: unset(),
      criteria: unset(),
      standing: { outcome: null, by: null, duplicateOf: null },
      decidedAt: null,
      model: null,
    }),
    brief: NO_BRIEF,
    nextSend: null,
    history: [historyEntry()],
  });
}

export function triageFailedItem(): WorkItemDetail {
  const reason = "The model's answer did not match triage/v1.";
  return workItemDetail({
    item: workItem({
      state: "new",
      status: "triage_failed",
      wait: { kind: "triage_failed", reason },
      priority: { label: null, by: null, reason: null, cites: [], setBy: null },
    }),
    triage: workTriage({
      priority: unset(),
      labels: unset(),
      standing: { outcome: "failed", by: "oxagen", duplicateOf: null },
      failure: { reason, at: DECIDED },
    }),
    brief: NO_BRIEF,
    nextSend: null,
  });
}

/** Triage drafted two criteria, and nothing is saved yet. */
export function triageDraftItem(): WorkItemDetail {
  return workItemDetail({
    item: workItem({
      state: "triaged",
      status: "brief_to_approve",
      wait: { kind: "brief_to_approve", fromTriage: true, reopened: null },
    }),
    brief: {
      state: "triage_draft",
      revisions: [],
      triageCriteria: ["The export retries after a 429.", "A test covers the retry."],
      repository: "acme/platform",
    },
    nextSend: null,
  });
}

/** A draft brief saved for the item's current revision, waiting for approval. */
export function draftBriefItem(): WorkItemDetail {
  return workItemDetail({
    item: workItem({
      state: "triaged",
      status: "brief_to_approve",
      wait: { kind: "brief_to_approve", fromTriage: false, reopened: null },
    }),
    brief: {
      state: "draft",
      revisions: [briefRevision({ approved: null, digest: DRAFT_DIGEST })],
      triageCriteria: [],
      repository: "acme/platform",
    },
    nextSend: null,
  });
}

export function needsInfoItem(): WorkItemDetail {
  const question = "Which export: the CSV one or the scheduled report?";
  return workItemDetail({
    item: workItem({
      state: "needs_info",
      status: "needs_info",
      wait: { kind: "needs_info", question },
    }),
    triage: workTriage({
      questions: [question],
      standing: { outcome: "needs_info", by: "oxagen", duplicateOf: null },
    }),
    brief: NO_BRIEF,
    nextSend: null,
  });
}

export function possibleDuplicateItem(): WorkItemDetail {
  return workItemDetail({
    item: workItem({
      state: "triaged",
      status: "possible_duplicate",
      wait: { kind: "possible_duplicate", of: { id: "wi_3cd", number: "WI-3" } },
    }),
    triage: workTriage({
      duplicates: ["wi_3cd"],
      standing: { outcome: "duplicate", by: "oxagen", duplicateOf: "wi_3cd" },
    }),
    brief: NO_BRIEF,
    nextSend: null,
  });
}

/** The issue changed after brief revision 1 was approved: Approve revision 2. */
export function changedItem(): WorkItemDetail {
  return workItemDetail({
    item: workItem({
      state: "changed",
      status: "changed",
      revision: 2,
      version: 6,
      wait: { kind: "changed", cause: "source", at: "2026-10-01T10:30:00Z", approvedRevision: 1 },
      description: "The export fails when the API answers 429 or 503.",
      sourceRevisions: [
        workItem().sourceRevisions[0] ?? {
          revision: 1,
          at: ARRIVED,
          kind: "collected",
          subject: "Retry the export when the API answers 429",
          description: null,
          labels: [],
        },
        {
          revision: 2,
          at: "2026-10-01T10:30:00Z",
          kind: "changed",
          subject: "Retry the export when the API answers 429",
          description: "The export fails when the API answers 429 or 503.",
          labels: ["Bug"],
        },
      ],
    }),
    brief: {
      state: "out_of_date",
      revisions: [briefRevision()],
      triageCriteria: [],
      repository: "acme/platform",
    },
    nextSend: null,
  });
}

export function readyItem(): WorkItemDetail {
  return workItemDetail();
}

export function sendRejectedItem(): WorkItemDetail {
  const reason = "CI runner 6 refused the launch: Claude Code on that runner is signed out.";
  return workItemDetail({
    item: workItem({
      status: "send_rejected",
      wait: { kind: "send_rejected", at: "2026-10-01T10:06:00Z", reason },
    }),
    nextSend: { send: 2, key: "wi_12ab:r1:s2" },
    sends: [
      workSend({
        delivery: "rejected",
        ended: true,
        rejected: { reason, at: "2026-10-01T10:06:00Z" },
      }),
    ],
  });
}

export function waitingItem(): WorkItemDetail {
  return workItemDetail({
    item: workItem({
      state: "sent",
      status: "waiting_for_claim",
      tab: "running",
      wait: {
        kind: "waiting_for_claim",
        runtime: "Build box",
        sentAt: SENT_AT,
        lastPollAt: "2026-10-01T10:04:00Z",
      },
    }),
    nextSend: null,
    sends: [workSend()],
  });
}

export function noAnswerItem(): WorkItemDetail {
  return workItemDetail({
    item: workItem({
      state: "sent",
      status: "no_answer",
      tab: "running",
      wait: { kind: "no_answer", runtime: "Build box", lastPollAt: "2026-10-01T10:40:00Z" },
    }),
    nextSend: null,
    sends: [workSend({ noAnswer: true, deliveredAt: "2026-10-01T10:06:00Z" })],
  });
}

const RUNNING_SEND = {
  delivery: "running" as const,
  deliveredAt: "2026-10-01T10:06:00Z",
  claimedAt: CLAIMED_AT,
  firstRunAt: FIRST_RUN_AT,
  runs: [{ id: "ses_01run", cost: null, tier: "gateway" }],
  cost: { runs: 1, knownRuns: 0, total: null },
};

export function runningItem(): WorkItemDetail {
  return workItemDetail({
    item: workItem({
      state: "running",
      status: "running",
      tab: "running",
      wait: { kind: "running", changedSinceSend: false, changedAt: null, briefRevision: 1 },
      cost: { runs: 1, knownRuns: 0, total: null },
    }),
    nextSend: null,
    sends: [workSend(RUNNING_SEND)],
  });
}

/** A stop was asked for and no run was ever linked: Withdraw the send. */
export function stoppingItem(): WorkItemDetail {
  return workItemDetail({
    item: workItem({
      state: "sent",
      status: "stopping",
      tab: "running",
      wait: { kind: "stopping", runtime: "Build box" },
    }),
    nextSend: null,
    sends: [
      workSend({
        delivery: "stopping",
        claimedAt: CLAIMED_AT,
        stopRequested: { reason: "Wrong repository.", by: "Marcus Bell", at: "2026-10-01T10:20:00Z" },
      }),
    ],
  });
}

const PULL_REQUEST = {
  repository: "acme/platform",
  number: 641,
  url: "https://github.com/acme/platform/pull/641",
  head: HEAD,
  headAt: HEAD_AT,
  merged: null,
  closedAt: null,
};

/** A send whose run ended with a pull request, every required check passing on its head. */
export function reviewedSend(overrides: Partial<WorkSend> = {}): WorkSend {
  return workSend({
    delivery: "run_ended",
    ended: true,
    deliveredAt: "2026-10-01T10:06:00Z",
    claimedAt: CLAIMED_AT,
    firstRunAt: FIRST_RUN_AT,
    runEndedAt: RUN_ENDED_AT,
    runs: [
      {
        id: "ses_01run",
        cost: { micros: "1240000", currency: "USD", basis: "gateway_observed" },
        tier: "gateway",
      },
    ],
    cost: { runs: 1, knownRuns: 1, total: { micros: "1240000", currency: "USD" } },
    pullRequest: PULL_REQUEST,
    requiredChecks: ["test", "typecheck"],
    checks: [
      { name: "test", conclusion: "success", required: true },
      { name: "typecheck", conclusion: "success", required: true },
      { name: "lint", conclusion: "failure", required: false },
    ],
    checksWord: "passing",
    gate: { open: true, block: null, detail: null },
    claims: [
      {
        criterion: "c1",
        text: "Added a backoff that reads Retry-After.",
        head: HEAD,
        current: true,
      },
    ],
    ...overrides,
  });
}

function inReview(send: WorkSend, wait: Item["wait"], extra: Partial<Item> = {}): WorkItemDetail {
  return workItemDetail({
    item: workItem({
      state: "review",
      status: "in_review",
      tab: "review",
      wait,
      cost: send.cost,
      ...extra,
    }),
    nextSend: { send: 2, key: "wi_12ab:r1:s2" },
    sends: [send],
  });
}

export function inReviewItem(): WorkItemDetail {
  return inReview(reviewedSend(), { kind: "ready_for_review", head: HEAD });
}

export function checkFailedItem(): WorkItemDetail {
  return inReview(
    reviewedSend({
      checks: [
        { name: "test", conclusion: "failure", required: true },
        { name: "typecheck", conclusion: "success", required: true },
      ],
      checksWord: "failing",
      gate: { open: false, block: "check_failed", detail: "test" },
    }),
    { kind: "check_failed", check: "test", conclusion: "failure", head: HEAD },
  );
}

export function checkMissingItem(): WorkItemDetail {
  return inReview(
    reviewedSend({
      requiredChecks: ["test", "e2e"],
      checks: [{ name: "test", conclusion: "success", required: true }],
      checksWord: "missing",
      gate: { open: false, block: "check_missing", detail: "e2e" },
    }),
    { kind: "check_missing", check: "e2e", head: HEAD },
  );
}

export function noRequiredChecksItem(): WorkItemDetail {
  return inReview(
    reviewedSend({
      requiredChecks: [],
      checks: [{ name: "lint", conclusion: "success", required: false }],
      checksWord: "none_required",
    }),
    { kind: "no_required_checks", head: HEAD },
  );
}

/** The head moved past the commit the agent's claims and the earlier checks were on. */
export function staleEvidenceItem(): WorkItemDetail {
  return inReview(
    reviewedSend({
      checks: [{ name: "test", conclusion: "pending", required: true }],
      earlierChecks: {
        head: EARLIER_HEAD,
        checks: [{ name: "test", conclusion: "success", required: true }],
      },
      checksWord: "running",
      gate: { open: false, block: "check_missing", detail: "typecheck" },
      claims: [
        {
          criterion: "c1",
          text: "Added a backoff that reads Retry-After.",
          head: EARLIER_HEAD,
          current: false,
        },
      ],
    }),
    { kind: "new_head", head: HEAD, earlier: EARLIER_HEAD, at: HEAD_AT },
  );
}

export function mergedBeforeReviewItem(): WorkItemDetail {
  return inReview(
    reviewedSend({
      pullRequest: { ...PULL_REQUEST, merged: { at: MERGED_AT, mergeCommit: MERGE_COMMIT } },
    }),
    { kind: "merged_before_review", at: MERGED_AT },
  );
}

export function closedWithoutMergingItem(): WorkItemDetail {
  return inReview(
    reviewedSend({
      pullRequest: { ...PULL_REQUEST, closedAt: "2026-10-01T12:00:00Z" },
      checksWord: "pr_closed",
      gate: { open: false, block: "pr_closed", detail: null },
    }),
    { kind: "pr_closed", at: "2026-10-01T12:00:00Z" },
  );
}

/** Send 2, a return, reported no usage. Send 1's run cost $1.24. */
export function costUnknownItem(): WorkItemDetail {
  const second = reviewedSend({
    id: "wo_2b",
    send: 2,
    key: "wi_12ab:r1:s2",
    runs: [{ id: "ses_02run", cost: null, tier: "harness" }],
    runtime: { name: "Amara's laptop", tier: "harness" },
    cost: { runs: 1, knownRuns: 0, total: null },
  });
  const first = reviewedSend({
    delivery: "returned",
    returned: { reason: "The 429 still has no Retry-After.", by: "Marcus Bell", at: "2026-10-01T11:30:00Z" },
    pullRequest: null,
    checksWord: "no_pull_request",
  });
  const detail = inReview(second, { kind: "ready_for_review", head: HEAD }, {
    cost: { runs: 2, knownRuns: 1, total: { micros: "1240000", currency: "USD" } },
  });
  return { ...detail, nextSend: { send: 3, key: "wi_12ab:r1:s3" }, sends: [second, first] };
}

const ACCEPTANCE = {
  head: HEAD,
  by: "Marcus Bell",
  at: "2026-10-01T12:10:00Z",
  criteria: ["c1", "c2"],
  requiredChecks: ["test", "typecheck"],
};

export function acceptedItem(): WorkItemDetail {
  return workItemDetail({
    item: workItem({
      state: "review",
      status: "accepted",
      tab: "review",
      wait: { kind: "accepted_waiting_merge", by: "Marcus Bell", head: HEAD },
    }),
    nextSend: null,
    sends: [
      reviewedSend({
        acceptance: ACCEPTANCE,
        gate: { open: false, block: "already_accepted", detail: HEAD },
      }),
    ],
  });
}

export function doneItem(): WorkItemDetail {
  return workItemDetail({
    item: workItem({
      state: "done",
      status: "done",
      tab: "done",
      finishedAt: MERGED_AT,
      wait: {
        kind: "done",
        accepted: { by: "Marcus Bell", at: ACCEPTANCE.at, head: HEAD },
        mergedAt: MERGED_AT,
      },
    }),
    nextSend: null,
    sends: [
      reviewedSend({
        pullRequest: { ...PULL_REQUEST, merged: { at: MERGED_AT, mergeCommit: MERGE_COMMIT } },
        acceptance: ACCEPTANCE,
        gate: { open: false, block: "already_accepted", detail: HEAD },
      }),
    ],
  });
}

export function closedDuplicateItem(): WorkItemDetail {
  return workItemDetail({
    item: workItem({
      state: "closed",
      status: "closed",
      tab: "done",
      finishedAt: "2026-10-01T11:00:00Z",
      wait: {
        kind: "closed",
        resolution: "duplicate",
        by: "Marcus Bell",
        at: "2026-10-01T11:00:00Z",
        reason: "Duplicate of WI-3.",
      },
    }),
    brief: NO_BRIEF,
    nextSend: null,
  });
}

/** A workspace Viewer on a ready item: every action reads disabled. */
export function viewerOnlyItem(): WorkItemDetail {
  return { ...readyItem(), viewer: { canControl: false, canApprove: false } };
}

// ---- the agents a send can go to ------------------------------------------

export function workTarget(overrides: Partial<WorkTarget> = {}): WorkTarget {
  return {
    id: "agt_stella",
    name: "Stella",
    harness: "stella",
    runtime: { id: "rtm_buildbox", name: "Build box", tier: "gateway" },
    host: { name: "build-box", lastPollAt: "2026-10-01T10:04:00Z", takesWorkOrders: true },
    operates: true,
    busyWith: null,
    canTake: true,
    reason: null,
    quiet: false,
    ...overrides,
  };
}

/** Two agents that can take a send, and three that cannot, each with its reason. */
export function workTargets(): WorkTargetList {
  return {
    agents: [
      workTarget(),
      workTarget({
        id: "agt_claude",
        name: "Release manager",
        harness: "claude-code",
        runtime: { id: "rtm_ci6", name: "CI runner 6", tier: "harness" },
        host: { name: "ci-runner-6", lastPollAt: "2026-10-01T08:00:00Z", takesWorkOrders: true },
        quiet: true,
      }),
      workTarget({
        id: "agt_codex",
        name: "Docs writer",
        harness: "codex",
        runtime: null,
        host: null,
        canTake: false,
        reason: "no_runtime",
      }),
      workTarget({
        id: "agt_cursor",
        name: "Test fixer",
        harness: "cursor",
        host: { name: "marcus-laptop", lastPollAt: "2026-10-01T10:00:00Z", takesWorkOrders: false },
        canTake: false,
        reason: "host_outdated",
      }),
      workTarget({
        id: "agt_busy",
        name: "Triage bot",
        busyWith: { id: "wi_7ef", number: "WI-7" },
        canTake: false,
        reason: "busy",
      }),
    ],
  };
}

// ---- the DataSource ---------------------------------------------------------

export function workItemSource(
  read: Read<WorkItemDetail>,
  targets: Read<WorkTargetList> = readOk(workTargets()),
) {
  const calls: unknown[][] = [];
  const targetCalls: unknown[][] = [];
  const refuse = () => Promise.reject(new Error("not a Work item read"));
  const source: DataSource = {
    runtimes: { list: refuse, agents: refuse, named: refuse },
    work: {
      list: refuse,
      get: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(read);
      },
      targets: (...args: unknown[]) => {
        targetCalls.push(args);
        return Promise.resolve(targets);
      },
      outcomes: refuse,
      collectors: refuse,
      priorities: refuse,
    },
    conversations: { latest: refuse, list: refuse, byId: refuse },
    pretenant: { orgs: refuse, workspaces: refuse },
    shell: {
      context: refuse,
      preferences: refuse,
      counts: refuse,
      notifications: refuse,
      assistantEngine: refuse,
    },
    billing: {
      plan: refuse,
      usageCredits: refuse,
      retention: refuse,
      bucket: refuse,
      contractRate: refuse,
      invoices: refuse,
    },
    runs: {
      list: refuse,
      get: refuse,
      frameBody: refuse,
      cost: refuse,
      turns: refuse,
      transcript: refuse,
      chain: refuse,
      commands: refuse,
      outputs: refuse,
      work: refuse,
      issues: refuse,
      context: refuse,
      findings: refuse,
    },
    approvals: { pending: refuse, resolved: refuse, resolvedSince: refuse },
    interjections: { open: refuse, forRun: refuse },
    agents: { list: refuse, get: refuse, toolbelt: refuse, incidents: refuse },
    spend: {
      byGroup: refuse,
      fleet: refuse,
      drill: refuse,
      waste: refuse,
      gatewayPolicy: refuse,
      budgets: refuse,
      findings: refuse,
      findingEvidence: refuse,
      priceBook: refuse,
      operatorRanking: refuse,
      perMergedPr: refuse,
      unpricedModels: refuse,
      unproductive: refuse,
    },
    onboarding: { state: refuse, firstFrame: refuse },
    org: {
      members: refuse,
      roles: refuse,
      workspaces: refuse,
      apiKeys: refuse,
      costCenters: refuse,
      modelCredential: refuse,
      dataPlane: refuse,
      slackConnection: refuse,
      workspaceFacts: refuse,
      sso: refuse,
    },
    skills: { inventory: refuse, configuration: refuse },
    audit: {
      events: refuse,
      exportEvents: refuse,
      retention: refuse,
      bundle: refuse,
    },
    steering: {
      records: refuse,
      record: refuse,
      proposals: refuse,
      contextPr: refuse,
      contextPrDiff: refuse,
      freshness: refuse,
      layout: refuse,
      hub: refuse,
      workspaceMemories: refuse,
      workspaceMemory: refuse,
      memoryPrRecords: refuse,
      deliveries: refuse,
      memories: refuse,
      tree: refuse,
    },
    steeringRepo: { get: refuse },
    tools: {
      versions: refuse,
      grants: refuse,
      killSwitches: refuse,
      approvalRules: refuse,
      connections: refuse,
      mcpServers: refuse,
      toolbelts: refuse,
      toolbelt: refuse,
    },
    mandates: { list: refuse, get: refuse },
  };
  return { source, calls, targetCalls };
}
