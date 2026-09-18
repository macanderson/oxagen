// Typed Fleet values for the Fleet component tests (ARCHITECTURE.md §5): runs
// rows, pending approvals and a DataSource that answers Fleet's reads with
// what a test hands it. Importable from tests only (`testOnlyTarget` in
// src/test/arch/layers.ts).
import type { ApprovalItem } from "@/data/contracts/approvals";
import type { MandateList } from "@/data/contracts/mandates";
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
    operatorId: "usr_marcusbell",
    status: "live",
    turns: 34,
    steps: 271,
    frames: 1204,
    cost: {
      micros: "4131265",
      currency: "USD",
      basis: "gateway_observed",
    },
    taskRef: "ENG-4121 cut the 3.2 release",
    name: "Cut the 3.2 release branch",
    summary: {
      text: "Cut release/3.2 from main, bumped eleven package versions, and opened the release pull request. Two test jobs were re-run after a flake in the e2e suite.",
      generatedAt: at(-120),
      model: "z-ai/glm-flash-latest",
    },
    replayGrade: "fork",
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
    createdAt: at(-150),
    expiresAt: at(450),
    ...overrides,
  };
}

export function runPage(
  runs: RunRow[],
  nextCursor: string | null = null,
): Read<RunPage> {
  return readOk({ runs, nextCursor });
}

type FleetReads = {
  runs: Read<RunPage>;
  approvals: Read<ApprovalItem[]>;
  /** Only read when a parked call names a mandate; refused when absent. */
  mandates?: Read<MandateList>;
};

/** A DataSource answering Fleet's reads; `calls` records their arguments. */
export function fleetSource(reads: FleetReads) {
  const calls: {
    runs: unknown[][];
    approvals: unknown[][];
    mandates: unknown[][];
  } = {
    runs: [],
    approvals: [],
    mandates: [],
  };
  const refuse = () => Promise.reject(new Error("not a Fleet read"));
  const source: DataSource = {
    pretenant: { orgs: refuse, workspaces: refuse },
    shell: { context: refuse },
    runs: {
      list: (...args) => {
        calls.runs.push(args);
        return Promise.resolve(reads.runs);
      },
      get: refuse,
      frameBody: refuse,
      cost: refuse,
      transcript: refuse,
    },
    approvals: {
      pending: (...args) => {
        calls.approvals.push(args);
        return Promise.resolve(reads.approvals);
      },
    },
    agents: {
      list: refuse,
      get: refuse,
      toolbelt: refuse,
      incidents: refuse,
    },
    billing: {
      plan: refuse,
      usageCredits: refuse,
      bucket: refuse,
      contractRate: refuse,
      invoices: refuse,
    },
    spend: {
      byGroup: refuse,
      fleet: refuse,
      drill: refuse,
      waste: refuse,
      budgets: refuse,
      findings: refuse,
      findingEvidence: refuse,
    },
    onboarding: { state: refuse, firstFrame: refuse },
    org: {
      members: refuse,
      roles: refuse,
      workspaces: refuse,
      apiKeys: refuse,
      modelCredential: refuse,
    },
    mandates: {
      list: (...args) => {
        calls.mandates.push(args);
        return reads.mandates === undefined
          ? Promise.reject(new Error("mandates.list was not expected"))
          : Promise.resolve(reads.mandates);
      },
    },
    audit: { events: refuse, exportEvents: refuse },
    skills: { inventory: refuse },
    steering: { records: refuse, proposals: refuse, contextPr: refuse },
    tools: { versions: refuse, grants: refuse, killSwitches: refuse },
  };
  return { source, calls };
}
