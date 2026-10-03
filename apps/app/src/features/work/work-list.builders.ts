// Typed Work values for the Work page, Work setup and Outcomes component tests
// (ARCHITECTURE.md §5), and a DataSource that answers the work reads with
// what a test hands it. Every other port
// refuses, so a test that reaches for a read the page does not make fails
// rather than passing on a stub. A read the test did not hand in refuses too.
// Importable from tests only (`testOnlyTarget` in src/test/arch/layers.ts).
import type {
  SendSummary,
  WorkCollector,
  WorkCollectorList,
  WorkItemList,
  WorkItemRow,
  WorkOutcomes,
  WorkPriorities,
  WorkTarget,
  WorkTargetList,
  WorkViewer,
} from "@/data/contracts/work";
import type { DataSource } from "@/data/ports";
import { type Read, readOk } from "@/data/read";

/** A head commit, as the review tables shorten it to 9e41b07. */
export const HEAD = "9e41b07c3d5f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

/** A work item on the Inbox whose brief waits for a person, P2 by triage. */
export function workItem(overrides: Partial<WorkItemRow> = {}): WorkItemRow {
  return {
    id: "wki_renewal01",
    number: "WI-1",
    title: "Show the renewal date on the billing page",
    origin: "manual",
    sourceUrl: null,
    repository: "a-intel/platform",
    requester: null,
    labels: [],
    arrivedAt: "2026-09-30T09:00:00Z",
    finishedAt: null,
    state: "triaged",
    status: "brief_to_approve",
    tab: "inbox",
    version: 3,
    revision: 1,
    priority: {
      label: "P2",
      by: "oxagen",
      reason: "A defect with a workaround.",
      cites: ["a-intel.work.priorities#3"],
      setBy: null,
    },
    wait: { kind: "brief_to_approve", fromTriage: true, reopened: null },
    send: null,
    cost: { runs: 0, knownRuns: 0, total: null },
    ...overrides,
  };
}

/** The latest send of an item: Release manager on CI runner 6, gateway tier. */
export function sendSummary(
  overrides: Partial<SendSummary> = {},
): SendSummary {
  return {
    id: "wko_send01",
    send: 1,
    key: "wki_renewal01:r1:s1",
    delivery: "running",
    noAnswer: false,
    agent: {
      id: "agt_releasemanager",
      name: "Release manager",
      harness: "claude-code",
    },
    runtime: { name: "CI runner 6", tier: "gateway" },
    requestedAt: "2026-09-30T13:02:00Z",
    pullRequest: null,
    checks: "no_pull_request",
    gate: { open: false, block: "run_active", detail: null },
    accepted: false,
    ...overrides,
  };
}

const VIEWER: WorkViewer = { canControl: true, canApprove: true };

export function workList(
  items: WorkItemRow[],
  viewer: WorkViewer = VIEWER,
  truncated = false,
): Read<WorkItemList> {
  return readOk({ items, truncated, viewer });
}

/** The GitHub collector, healthy, reading two repositories. */
export function collector(
  overrides: Partial<WorkCollector> = {},
): WorkCollector {
  return {
    name: "github",
    type: "github",
    connectionId: "con_github01",
    repos: ["a-intel/platform", "a-intel/billing-service"],
    health: "healthy",
    cursor: null,
    lastReconcile: null,
    lastSuccessAt: "2026-09-30T11:39:00Z",
    failedStreak: 0,
    nextCheckAt: null,
    lastEventAt: "2026-09-30T12:58:00Z",
    createdAt: "2026-09-01T10:00:00Z",
    ...overrides,
  };
}

/** The repositories the workspace links, which Add collector offers. */
export const LINKED_REPOS = [
  "a-intel/platform",
  "a-intel/billing-service",
  "a-intel/web",
];

export function collectorList(
  collectors: WorkCollector[],
  linked: string[] | null = LINKED_REPOS,
): Read<WorkCollectorList> {
  return readOk({ collectors, linked });
}

/** The priorities record a-intel.work.priorities v7, with three rules. */
export function priorities(
  overrides: Partial<WorkPriorities> = {},
): Read<WorkPriorities> {
  return readOk<WorkPriorities>({
    record: {
      lineage: "a-intel.work.priorities",
      version: 7,
      hash: "sha256:0f1e2d3c",
      rules: [
        { number: 2, text: "A customer cannot finish a task and has no workaround." },
        { number: 1, text: "Production is down, or customer data is at risk." },
        { number: 3, text: "A defect with a workaround." },
      ],
      publishedAt: "2026-09-20T10:00:00Z",
    },
    problem: null,
    last30Days: { suggestions: 118, failures: 2, corrections: 8 },
    ...overrides,
  });
}

/** An agent that can take a send now, on a gateway runtime whose host polled. */
export function target(overrides: Partial<WorkTarget> = {}): WorkTarget {
  return {
    id: "agt_releasemanager",
    name: "Release manager",
    harness: "claude-code",
    runtime: { id: "rtm_cirunner6", name: "CI runner 6", tier: "gateway" },
    host: {
      name: "ci-runner-6",
      lastPollAt: "2026-09-30T13:01:00Z",
      takesWorkOrders: true,
    },
    operates: true,
    busyWith: null,
    canTake: true,
    reason: null,
    quiet: false,
    ...overrides,
  };
}

export function targetList(agents: WorkTarget[]): Read<WorkTargetList> {
  return readOk({ agents });
}

/** The last 30 days: 23 accepted and merged, $412.37 known for 61 of 66 runs. */
export function outcomes(
  overrides: Partial<WorkOutcomes> = {},
): Read<WorkOutcomes> {
  return readOk<WorkOutcomes>({
    days: 30,
    since: "2026-09-02T00:00:00Z",
    acceptedMerged: 23,
    returned: 6,
    closed: { cancelled: 2, declined: 3, duplicate: 4 },
    leadTime: { medianHours: 19.5, p90Hours: 71, sample: 23 },
    touches: {
      perItem: 2.4,
      briefApprovals: 25,
      acceptances: 23,
      returns: 6,
      triageOverrides: 1,
      triageCorrections: 8,
    },
    cost: {
      runs: 66,
      knownRuns: 61,
      total: { micros: "412370000", currency: "USD" },
    },
    reopens: { cohort: 14, reopened: 1, waiting: 9 },
    truncated: false,
    weeks: [
      { week: "2026-09-07", acceptedMerged: 5, returned: 2, medianLeadHours: 22 },
      { week: "2026-09-14", acceptedMerged: 8, returned: 1, medianLeadHours: 18.5 },
      { week: "2026-09-21", acceptedMerged: 10, returned: 3, medianLeadHours: null },
    ],
    ...overrides,
  });
}

/** What each Work read answers. A read left out refuses. */
export type WorkReads = {
  list?: Read<WorkItemList>;
  collectors?: Read<WorkCollectorList>;
  priorities?: Read<WorkPriorities>;
  targets?: Read<WorkTargetList>;
  outcomes?: Read<WorkOutcomes>;
};

export function workSource(reads: WorkReads) {
  const calls: { read: string; args: unknown[] }[] = [];
  const refuse = () => Promise.reject(new Error("not a Work read"));
  function answer<T>(name: string, read: Read<T> | undefined) {
    return (...args: unknown[]): Promise<Read<T>> => {
      calls.push({ read: name, args });
      return read === undefined
        ? Promise.reject(new Error(`${name} was not expected`))
        : Promise.resolve(read);
    };
  }
  const source: DataSource = {
    runtimes: { list: refuse, agents: refuse, named: refuse },
    work: {
      list: answer("work.list", reads.list),
      get: refuse,
      targets: answer("work.targets", reads.targets),
      outcomes: answer("work.outcomes", reads.outcomes),
      collectors: answer("work.collectors", reads.collectors),
      priorities: answer("work.priorities", reads.priorities),
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
    agents: {
      list: refuse,
      get: refuse,
      toolbelt: refuse,
      incidents: refuse,
    },
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
      steeringPr: refuse,
      steeringPrDiff: refuse,
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
    changes: { changeSet: refuse, revisionDiff: refuse },
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
  return { source, calls };
}
