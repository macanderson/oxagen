// Typed steering values for the component tests of the two pages that read the
// steering port (ARCHITECTURE.md §5): a published record, one record's page, a
// proposal, a steering PR in each state of its machine, the freshness panel's
// read, a workspace memory with its page and its drawer read, a memory PR's
// records, and a DataSource that answers every steering read with what a test
// hands it.
//
// It lives here rather than in `features/steering` because the Steering page
// and one record's page both read this port, and no feature may reach into
// another's folder. `steeringSource` is the one stub of the seam: a second
// stub in the second feature would be a second place for it to fall behind
// `DataSource`. Test support only: src/test is never in a production bundle.
import type { AgentPage } from "@/data/contracts/agents";
import type { KillSwitchBoard } from "@/data/contracts/tools";
import type { DataSource } from "@/data/ports";
import type {
  SteeringPr,
  SteeringPrDiff,
  MemoryPage,
  MemoryPrRecords,
  OxagenTree,
  Proposal,
  ProposalPage,
  ProposalStatus,
  RecordDetail,
  RecordKind,
  RecordPage,
  SteeringFreshness,
  SteeringDeliveries,
  SteeringHub,
  SteeringLayout,
  WorkspaceMemory,
  WorkspaceMemoryDetail,
  WorkspaceMemoryPage,
  WorkspaceMemoryQuery,
} from "@/data/contracts/steering";
import { type Read, readOk } from "@/data/read";

export const AT = { org: "acme", ws: "core-platform" };
export const PROPOSAL_ID = "prp_01k5ru4a";
export const LINEAGE = "ctx.release.no-reread-changelog";
export const RECORD_PATH = `.oxagen/rules/${LINEAGE}.toml`;
export const PR_URL = "https://github.com/acme/core-platform/pull/519";

type PublishedRecord = RecordPage["records"][number];
type Check = SteeringPr["checks"][number];

export function publishedRecord(
  overrides: Partial<PublishedRecord> = {},
): PublishedRecord {
  return {
    id: "ctr_7k2m9q4x8r1t5v3w6y0z2a",
    lineage: LINEAGE,
    title: "Read CHANGELOG.md once per run",
    kind: "constraint",
    force: "must",
    constraintEffect: "forbid",
    sharingScope: "workspace",
    statement: "Do not re-read CHANGELOG.md after the first read in a run.",
    version: 3,
    commit: "4d5e6f7a8b9c",
    path: RECORD_PATH,
    publishedAt: "2026-09-12T09:16:40.000Z",
    ...overrides,
  };
}

/**
 * One record's page (#3395): the file is the backing, its history carries the
 * provenance, and the rollup carries the effect. A test that wants the
 * not-recorded states passes `{ provenance: null, effect: null }`.
 */
export function recordDetail(
  overrides: Partial<RecordDetail> = {},
): RecordDetail {
  return {
    record: { ...publishedRecord(), status: "active" },
    backing: "file",
    provenance: {
      commit: "4d5e6f7a8b9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e",
      authorName: "Dana Reyes",
      authorLogin: "dreyes",
      committedAt: "2026-09-12T09:16:40.000Z",
      summary: `context: publish ${LINEAGE}`,
    },
    effect: { rendered: 214, cited: 37 },
    versions: [
      {
        id: "crv_9m2x4q7r",
        version: 3,
        checksum: "b7f1c2d3e4a5",
        isLatest: true,
        publishedAt: "2026-09-12T09:16:40.000Z",
      },
    ],
    proposalId: PROPOSAL_ID,
    prUrl: PR_URL,
    ...overrides,
  };
}

export function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: PROPOSAL_ID,
    lineage: LINEAGE,
    kind: "constraint",
    force: "must",
    constraintEffect: "forbid",
    sharingScope: "workspace",
    statement: "Do not re-read CHANGELOG.md after the first read in a run.",
    rationale:
      "Three sealed runs across two agents read CHANGELOG.md again after the first read.",
    source: "agent:release-bot",
    support: {
      runs: ["arun_01k5rs7m", "arun_01k5rs9q", "arun_01k5rt2c"],
      agents: ["release-bot", "docs-bot"],
      recordIds: ["cta_01k5rt6c"],
      evidenceLinks: ["frame:arun_01k5rs7m/14", "frame:arun_01k5rs9q/22"],
    },
    status: "checks_passed",
    pr: {
      number: 519,
      url: PR_URL,
      provider: "github",
      repository: "acme/core-platform",
      branch: `steering/${LINEAGE}`,
    },
    checks: { passed: 6, total: 6 },
    updatedAt: "2026-09-15T09:10:00.000Z",
    ...overrides,
  };
}

const NAMES = [
  "schema",
  "lineage_uniqueness",
  "record_hash",
  "secret_pii_scan",
  "conflict_against_active",
  "constraint_effect",
] as const;

function checks(statuses: readonly Check["status"][]): Check[] {
  return NAMES.map((name, index) => {
    const status = statuses[index] ?? "pending";
    const done = status === "passed" || status === "failed";
    return {
      name,
      status,
      summary:
        status === "failed"
          ? "a string shaped like an access key on line 12"
          : status === "passed"
            ? `${name} holds`
            : "",
      detailsUrl: null,
      startedAt: status === "pending" ? null : "2026-09-15T09:11:00.000Z",
      completedAt: done ? "2026-09-15T09:12:00.000Z" : null,
    };
  });
}

const PASSED = checks(NAMES.map((): Check["status"] => "passed"));

const CHECKS: Record<ProposalStatus, Check[]> = {
  proposed: [],
  pr_open: checks([]),
  checks_running: checks(["passed", "passed", "running"]),
  checks_passed: PASSED,
  checks_failed: checks([
    "passed",
    "passed",
    "passed",
    "failed",
    "passed",
    "passed",
  ]),
  merged: PASSED,
  rejected: PASSED,
};

/** A steering PR at `status`, with the checks, pull request and merge that state carries. */
export function steeringPr(
  status: ProposalStatus,
  overrides: Partial<SteeringPr> = {},
): SteeringPr {
  const opened = status !== "proposed";
  return {
    proposalId: PROPOSAL_ID,
    lineage: LINEAGE,
    kind: "rule",
    status,
    governanceMode: opened ? "team" : null,
    pr: opened
      ? {
          number: 519,
          url: PR_URL,
          repository: "acme/core-platform",
          baseRef: "main",
          branch: `steering/${LINEAGE}`,
          headSha: status === "pr_open" ? null : "9f8e7d6c5b4a",
          provider: "github",
        }
      : null,
    raised: {
      statement: "Do not re-read CHANGELOG.md after the first read in a run.",
      rationale:
        "Three sealed runs across two agents read CHANGELOG.md again after the first read.",
      source: "agent:release-bot",
      sourceName: null,
      force: "must",
      constraintEffect: null,
      sharingScope: "workspace",
      support: {
        runs: ["arun_01k5rs7m", "arun_01k5rs9q"],
        agents: ["release-bot", "docs-bot"],
        recordIds: [],
        evidenceLinks: ["frame:arun_01k5rs7m/14"],
      },
      at: "2026-09-15T09:00:00.000Z",
    },
    body: opened ? `## Steering PR · ${LINEAGE}` : null,
    checks: CHECKS[status],
    onMerge: {
      path: RECORD_PATH,
      bundleVersion: { current: status === "merged" ? 42 : 41, afterMerge: 42 },
    },
    merged:
      status === "merged"
        ? {
            commit: "4d5e6f7a8b9c",
            at: "2026-09-15T09:20:00.000Z",
            promotionEventId: "ctp_8qm2x4",
            recordId: "ctr_7k2m9q4x",
            byName: "Dana Reyes",
            onHost: false,
          }
        : null,
    closed:
      status === "rejected"
        ? {
            at: "2026-09-15T09:30:00.000Z",
            reason: "Superseded by the release checklist",
            byName: "Dana Reyes",
            onHost: false,
          }
        : null,
    ...overrides,
  };
}

/** The diff of the steering PR `steeringPr()` opens: the one record file it adds. */
export function steeringPrDiff(
  overrides: Partial<SteeringPrDiff> = {},
): SteeringPrDiff {
  return {
    state: "diff",
    baseRef: "main",
    headSha: "9f8e7d6c5b4a",
    files: [
      {
        path: RECORD_PATH,
        status: "added",
        before: null,
        after:
          'lineage_id = "ctx.release.no-reread-changelog"\nstatement = "Do not re-read CHANGELOG.md after the first read in a run."\n',
        truncated: false,
      },
    ],
    moreFiles: false,
    ...overrides,
  };
}

export type SteeringReads = {
  /**
   * One read for every records call, or an answer per query: the Steering hub
   * reads every kind for its counts and a shelf then reads its own kind.
   */
  records:
    | Read<RecordPage>
    | ((q: { kind: RecordKind | null; offset: number }) => Read<RecordPage>);
  record: Read<RecordDetail>;
  proposals: Read<ProposalPage>;
  steeringPr: Read<SteeringPr>;
  /** The steering PR page's diff; not recorded in `calls`, so the hub's call tables stay as they were. */
  steeringPrDiff: Read<SteeringPrDiff>;
  freshness: Read<SteeringFreshness>;
  /** The main repository's layout; legacy unless a test sets it, so a record without a path keeps its `.oxagen/rules/` file. */
  layout: Read<SteeringLayout>;
  hub: Read<SteeringHub>;
  deliveries: Read<SteeringDeliveries>;
  memories: Read<MemoryPage>;
  /** One read for every Memories call, or an answer per query: the tab reads every state for its filters, then the page. */
  workspaceMemories:
    | Read<WorkspaceMemoryPage>
    | ((q: WorkspaceMemoryQuery) => Read<WorkspaceMemoryPage>);
  workspaceMemory: Read<WorkspaceMemoryDetail>;
  memoryPrRecords: Read<MemoryPrRecords>;
  tree: Read<OxagenTree>;
  /**
   * The agent registry, which the Assignments count, the Assignments body and
   * the Compiler read (features/steering/agents-read.ts). Not a Steering
   * read, so `calls` does not record it.
   */
  agents: Read<AgentPage>;
  /** The kill switches the Gates tab lists; not recorded in `calls` either. */
  killSwitches: Read<KillSwitchBoard>;
};

/** One enrolled agent, for the views that draw a row per agent set up for steering. */
export function enrolledAgent(
  overrides: Partial<AgentPage["agents"][number]> = {},
): AgentPage["agents"][number] {
  return {
    id: "agt_01k5rr2m",
    slug: "release-manager",
    name: "Release manager",
    description: null,
    agentKey: "acme.core-platform.release-manager",
    harness: "claude-code",
    managed: false,
    runtime: null,
    toolbelt: null,
    operatorId: null,
    operatorName: null,
    operatorAvatarUrl: null,
    principalId: null,
    credentials: 1,
    hosts: 1,
    host: null,
    status: "enrolled",
    enforcementTier: null,
    runs30d: 12,
    spend30d: null,
    tokens30d: null,
    mandates: null,
    incidents: 0,
    tamperIncidents: 0,
    tamperIncidentsRecorded: 0,
    ...overrides,
  };
}

/** A registry page holding `agents`, with the totals counted from them. */
export function agentPage(
  agents: AgentPage["agents"] = [enrolledAgent()],
): AgentPage {
  return {
    agents,
    nextCursor: null,
    totals: {
      identities: agents.length,
      retired: 0,
      enrolled: agents.filter((a) => a.status === "enrolled").length,
      unenrolled: agents.filter((a) => a.status === "unenrolled").length,
      holdingMandate: null,
      mandateHolders: [],
      tamperIncidents: 0,
      tamper: { recorded: 0, open: 0, newest: null },
    },
  };
}

/** The freshness panel's read: a bound repository, one publication, both gates off. */
export function steeringFreshness(
  overrides: Partial<SteeringFreshness> = {},
): SteeringFreshness {
  return {
    version: 12,
    headCommit: "9a41c0e7bd2311f4c0a1b2c3d4e5f60718293a4b",
    publishedAt: "2026-09-01T10:00:00.000Z",
    repository: "acme/platform",
    defaultBranch: "main",
    gates: { autoSync: false, blockStaleRuns: false },
    sync: null,
    ...overrides,
  };
}

/** The hub header's read: `team` declared on the main repository, three proposals waiting. */
export function steeringHub(overrides: Partial<SteeringHub> = {}): SteeringHub {
  return {
    governance: {
      state: "read",
      repository: "acme/platform",
      path: ".oxagen/rules/governance.toml",
      mode: "team",
    },
    proposalsWaiting: 3,
    states: { open: 3, merged: 6, closed: 1 },
    memoriesWaiting: 2,
    ...overrides,
  };
}

/** The agent key a sample memory names: the enrolled agent above. */
export const MEMORY_AGENT = "acme.core-platform.release-manager";
export const MEMORY_ID = "mem_01k5rw3draft";
export const MEMORY_PR_URL = "https://github.com/acme/oxagen-core-platform/pull/59";

/** A waiting Claude Code memory that nine runs used, in no memory PR yet. */
export function workspaceMemory(
  overrides: Partial<WorkspaceMemory> = {},
): WorkspaceMemory {
  return {
    id: MEMORY_ID,
    label: "Draft releases only",
    summary: "Open every release as a draft first.",
    statement:
      "Open every release as a draft. A person publishes it after the notes are read.",
    state: "waiting",
    capture: "local_gateway",
    harness: "claude-code",
    agent: MEMORY_AGENT,
    source: "claude-code:~/.claude/projects/core/memory/feedback_draft_releases.md",
    repos: ["github.com/acme/platform"],
    memoryType: "feedback",
    kind: "procedure",
    uses: 9,
    useSignal: true,
    lastUsedAt: "2026-09-30T08:00:00.000Z",
    createdAt: "2026-09-20T10:00:00.000Z",
    promotedLineage: null,
    memoryPr: null,
    ...overrides,
  };
}

/** One group per memory, each memory speaking for itself. */
export function workspaceMemoryPage(
  memories: readonly WorkspaceMemory[] = [workspaceMemory()],
  overrides: Partial<WorkspaceMemoryPage> = {},
): WorkspaceMemoryPage {
  return {
    groups: memories.map((memory) => ({
      memory,
      members: [memory],
      uses: memory.uses,
      lastUsedAt: memory.lastUsedAt,
    })),
    totalGroups: memories.length,
    totalMemories: memories.length,
    truncated: false,
    waiting: memories.filter((m) => m.state === "waiting").length,
    ...overrides,
  };
}

/** The drawer's read of `memory`: the run that wrote it and two runs that read it. */
export function workspaceMemoryDetail(
  memory: WorkspaceMemory = workspaceMemory(),
  overrides: Partial<WorkspaceMemoryDetail> = {},
): WorkspaceMemoryDetail {
  return {
    memory: {
      ...memory,
      run: "tse_01k5rt2q",
      evidence: ["frame:tse_01k5rt2q/3"],
      retiredAt: null,
      retiredReason: null,
    },
    uses: [
      {
        run: "tse_01k5ru9a",
        signal: "read",
        count: 2,
        usedAt: "2026-09-30T08:00:00.000Z",
      },
      {
        run: "arun_01k5rs7m",
        signal: "read",
        count: 1,
        usedAt: "2026-09-29T08:00:00.000Z",
      },
    ],
    usesTotal: 2,
    memoryPr: null,
    ...overrides,
  };
}

/** Memory PR #59, open on its memory branch, proposing one record that cites one memory. */
export function memoryPrRecords(
  overrides: Partial<MemoryPrRecords> = {},
): MemoryPrRecords {
  return {
    pullRequest: {
      number: 59,
      url: MEMORY_PR_URL,
      repository: "acme/oxagen-core-platform",
      branch: "memory/2026-09-27",
      status: "open",
      openedAt: "2026-09-27T09:00:00.000Z",
      settledAt: null,
    },
    branchRead: true,
    records: [
      {
        action: "propose",
        path: "steering/memory/release/release.draft-releases.md",
        lineage: "core.release.draft-releases",
        kind: "procedure",
        title: "Draft releases only",
        summary: "Open every release as a draft first.",
        memories: [
          {
            id: MEMORY_ID,
            statement: "Open every release as a draft.",
            agent: MEMORY_AGENT,
            run: "tse_01k5rt2q",
            evidence: ["frame:tse_01k5rt2q/3"],
            state: "in_pr",
          },
        ],
        dropped: null,
      },
    ],
    ...overrides,
  };
}

/** A DataSource answering the three Steering reads; `calls` records their arguments. */
export function steeringSource(overrides: Partial<SteeringReads> = {}) {
  const reads: SteeringReads = {
    records: readOk({ records: [publishedRecord()], total: 1 }),
    record: readOk(recordDetail()),
    proposals: readOk({ proposals: [proposal()], total: 1 }),
    steeringPr: readOk(steeringPr("checks_passed")),
    steeringPrDiff: readOk(steeringPrDiff()),
    freshness: readOk(steeringFreshness()),
    layout: readOk({ layout: "legacy" }),
    hub: readOk(steeringHub()),
    deliveries: readOk({
      runs: [],
      undelivered: [],
      scanned: 0,
      truncated: false,
    }),
    memories: readOk({ memories: [], total: 0 }),
    workspaceMemories: readOk(workspaceMemoryPage()),
    workspaceMemory: readOk(workspaceMemoryDetail()),
    memoryPrRecords: readOk(memoryPrRecords()),
    tree: readOk({ state: "unbound" }),
    // An empty workspace is the neutral answer for tests that set neither.
    agents: readOk(agentPage([])),
    killSwitches: readOk({
      denyGeneration: { org: 0, workspace: 0 },
      switches: [],
      truncated: false,
    }),
    ...overrides,
  };
  const calls: Record<
    Exclude<keyof SteeringReads, "agents" | "killSwitches" | "steeringPrDiff">,
    unknown[][]
  > = {
    records: [],
    record: [],
    proposals: [],
    steeringPr: [],
    freshness: [],
    layout: [],
    hub: [],
    deliveries: [],
    memories: [],
    workspaceMemories: [],
    workspaceMemory: [],
    memoryPrRecords: [],
    tree: [],
  };
  const refuse = () => Promise.reject(new Error("not a Steering read"));
  const source: DataSource = {
    runtimes: { list: refuse, agents: refuse, named: refuse },
    work: {
      list: refuse,
      get: refuse,
      targets: refuse,
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
      list: () => Promise.resolve(reads.agents),
      get: refuse,
      toolbelt: refuse,
      incidents: refuse,
    },
    billing: {
      plan: refuse,
      usageCredits: refuse,
      retention: refuse,
      bucket: refuse,
      contractRate: refuse,
      invoices: refuse,
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
    mandates: { list: refuse, get: refuse },
    audit: {
      events: refuse,
      exportEvents: refuse,
      retention: refuse,
      bundle: refuse,
    },
    skills: { inventory: refuse, configuration: refuse },
    steering: {
      deliveries: (...args) => {
        calls.deliveries.push(args);
        return Promise.resolve(reads.deliveries);
      },
      records: (...args) => {
        calls.records.push(args);
        const read = reads.records;
        return Promise.resolve(
          typeof read === "function" ? read(args[1]) : read,
        );
      },
      record: (...args) => {
        calls.record.push(args);
        return Promise.resolve(reads.record);
      },
      proposals: (...args) => {
        calls.proposals.push(args);
        return Promise.resolve(reads.proposals);
      },
      steeringPr: (...args) => {
        calls.steeringPr.push(args);
        return Promise.resolve(reads.steeringPr);
      },
      steeringPrDiff: () => Promise.resolve(reads.steeringPrDiff),
      freshness: (...args) => {
        calls.freshness.push(args);
        return Promise.resolve(reads.freshness);
      },
      layout: (...args) => {
        calls.layout.push(args);
        return Promise.resolve(reads.layout);
      },
      hub: (...args) => {
        calls.hub.push(args);
        return Promise.resolve(reads.hub);
      },
      memories: (...args) => {
        calls.memories.push(args);
        return Promise.resolve(reads.memories);
      },
      workspaceMemories: (...args) => {
        calls.workspaceMemories.push(args);
        const read = reads.workspaceMemories;
        return Promise.resolve(
          typeof read === "function" ? read(args[1]) : read,
        );
      },
      workspaceMemory: (...args) => {
        calls.workspaceMemory.push(args);
        return Promise.resolve(reads.workspaceMemory);
      },
      memoryPrRecords: (...args) => {
        calls.memoryPrRecords.push(args);
        return Promise.resolve(reads.memoryPrRecords);
      },
      tree: (...args) => {
        calls.tree.push(args);
        return Promise.resolve(reads.tree);
      },
    },
    steeringRepo: { get: refuse },
    tools: {
      versions: refuse,
      grants: refuse,
      killSwitches: () => Promise.resolve(reads.killSwitches),
      approvalRules: refuse,
      connections: refuse,
      mcpServers: refuse,
      toolbelts: refuse,
      toolbelt: refuse,
    },
  };
  return { source, calls };
}
