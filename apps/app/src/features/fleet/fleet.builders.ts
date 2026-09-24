// Typed Fleet values for the Fleet component tests (ARCHITECTURE.md §5): runs
// rows, pending approvals and a DataSource that answers Fleet's reads with
// what a test hands it. Importable from tests only (`testOnlyTarget` in
// src/test/arch/layers.ts).
import type { AgentPage } from "@/data/contracts/agents";
import type { ApprovalItem, ApprovalQueue } from "@/data/contracts/approvals";
import type { RunPage } from "@/data/contracts/runs";
import type { DataSource } from "@/data/ports";
import { type Read, readOk } from "@/data/read";

type RunRow = RunPage["runs"][number];

/** The instant every Fleet test renders at. */
export const NOW = Date.parse("2026-09-15T09:00:00.000Z");

const at = (secondsFromNow: number): string =>
  new Date(NOW + secondsFromNow * 1000).toISOString();

export function runRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "arun_7k2m9q",
    source: "ledger",
    agentKey: "acme.core.release-bot",
    operatorId: "prn_marcusbell",
    operatorKind: "human",
    operatorName: "Marcus Bell",
    status: "live",
    outcome: "running",
    turns: 34,
    steps: 271,
    frames: 1204,
    cost: {
      micros: "4131265",
      currency: "USD",
      basis: "gateway_observed",
    },
    model: null,
    machine: null,
    taskRef: "ENG-4121 cut the 3.2 release",
    name: "Cut the 3.2 release branch",
    summary: {
      text: "Cut release/3.2 from main, bumped eleven package versions, and opened the release pull request. Two test jobs were re-run after a flake in the e2e suite.",
      generatedAt: at(-120),
      model: "z-ai/glm-flash-latest",
    },
    replayGrade: "fork",
    verdict: "flipped",
    enforcementTier: "harness",
    completenessGaps: [],
    canSummarize: false,
    startedAt: at(-3600),
    sealedAt: null,
    ...overrides,
  };
}

export function approvalItem(
  overrides: Partial<ApprovalItem> = {},
): ApprovalItem {
  return {
    id: "apr_q8t1",
    runId: null,
    tool: "create_release",
    agentKey: null,
    requester: "usr_marcusbell",
    mandateId: null,
    rule: null,
    autoEligibility: null,
    createdAt: at(-150),
    expiresAt: at(450),
    ...overrides,
  };
}

/**
 * The pending queue as `approvals.pending` answers it. `more` is the read
 * having stopped before the end of the queue, which is what the waiting tile
 * and the panel header mark with a `+`.
 */
export function approvalQueue(
  items: ApprovalItem[],
  more = false,
): Read<ApprovalQueue> {
  return readOk({ items, more });
}

export function runPage(
  runs: RunRow[],
  nextCursor: string | null = null,
): Read<RunPage> {
  return readOk({ runs, nextCursor });
}

/**
 * The workspace's agents as `agents.list` answers them: one row per key, and
 * the workspace total the Live runs tile reads its basis from.
 */
export function agentPage(
  keys: string[],
  identities: number = keys.length,
): Read<AgentPage> {
  return readOk({
    agents: keys.map((agentKey, index) => ({
      id: `agt_${String(index + 1)}`,
      slug: agentKey.split(".").at(-1) ?? agentKey,
      name: agentKey,
      description: null,
      agentKey,
      harness: "claude-code",
      operatorId: null,
      operatorName: null,
      principalId: null,
      credentials: 0,
      hosts: 0,
      host: null,
      status: "enrolled",
      enforcementTier: null,
      runs30d: 0,
      spend30d: null,
      tokens30d: null,
      mandates: null,
      incidents: 0,
      tamperIncidents: 0,
      tamperIncidentsRecorded: 0,
    })),
    nextCursor: null,
    totals: {
      identities,
      enrolled: identities,
      holdingMandate: null,
      tamperIncidents: 0,
      tamper: { recorded: 0, open: 0, newest: null },
    },
  });
}

type FleetReads = {
  runs: Read<RunPage>;
  approvals: Read<ApprovalQueue>;
  /**
   * The workspace's agents; an empty page when absent. A function answers
   * each page by the cursor it was asked for, for the roster's walk.
   */
  agents?: Read<AgentPage> | ((cursor: string | null) => Read<AgentPage>);
};

/** A DataSource answering Fleet's reads; `calls` records their arguments. */
export function fleetSource(reads: FleetReads) {
  const calls: {
    runs: unknown[][];
    approvals: unknown[][];
    agents: unknown[][];
  } = {
    runs: [],
    approvals: [],
    agents: [],
  };
  const refuse = () => Promise.reject(new Error("not a Fleet read"));
  const source: DataSource = {
    runtimes: { list: refuse, agents: refuse },
    pretenant: { orgs: refuse, workspaces: refuse },
    shell: {
      context: refuse,
      preferences: refuse,
      counts: refuse,
      notifications: refuse,
    },
    runs: {
      list: (...args) => {
        calls.runs.push(args);
        return Promise.resolve(reads.runs);
      },
      get: refuse,
      frameBody: refuse,
      cost: refuse,
      chain: refuse,
      outputs: refuse,
      work: refuse,
      outcomesSettings: refuse,
      transcript: refuse,
    },
    approvals: {
      pending: (...args) => {
        calls.approvals.push(args);
        return Promise.resolve(reads.approvals);
      },
      // Fleet reads only the pending approvals; the resolved ledger is a Run
      // page read (#3153).
      resolved: refuse,
      resolvedSince: refuse,
    },
    agents: {
      list: (...args) => {
        calls.agents.push(args);
        const agents = reads.agents;
        return Promise.resolve(
          typeof agents === "function"
            ? agents(args[1].cursor)
            : (agents ?? agentPage([])),
        );
      },
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
      unpricedModels: refuse,
    },
    onboarding: { state: refuse, firstFrame: refuse },
    org: {
      members: refuse,
      roles: refuse,
      workspaces: refuse,
      apiKeys: refuse,
      costCenters: refuse,
      modelCredential: refuse,
      sso: refuse,
    },
    // Fleet reads no mandate: the approval cards that draw a mandate bar are
    // the shell drawer's and the Run page's.
    mandates: { list: refuse, get: refuse },
    audit: { events: refuse, exportEvents: refuse },
    skills: { inventory: refuse, configuration: refuse },
    steering: {
      records: refuse,
      record: refuse,
      proposals: refuse,
      contextPr: refuse,
      freshness: refuse,
      deliveries: refuse,
    },
    tools: {
      versions: refuse,
      grants: refuse,
      killSwitches: refuse,
      approvalRules: refuse,
      connections: refuse,
      mcpServers: refuse,
    },
  };
  return { source, calls };
}
