// Typed Fleet values for the Fleet component tests (ARCHITECTURE.md §5): runs
// rows, pending approvals and a DataSource that answers Fleet's reads with
// what a test hands it. Importable from tests only (`testOnlyTarget` in
// src/test/arch/layers.ts).
import { refusingSource } from "@/test/refusing-source";
import type { ApprovalItem, ApprovalQueue } from "@/data/contracts/approvals";
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
    operatorId: "prn_marcusbell",
    operatorKind: "human",
    operatorName: "Marcus Bell",
    status: "live",
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

type FleetReads = {
  runs: Read<RunPage>;
  approvals: Read<ApprovalQueue>;
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

  const source: DataSource = refusingSource("Fleet", {
    runs: {
      list: (...args) => {
        calls.runs.push(args);
        return Promise.resolve(reads.runs);
      },
    },
    approvals: {
      pending: (...args) => {
        calls.approvals.push(args);
        return Promise.resolve(reads.approvals);
      },
    },
    mandates: {
      list: (...args) => {
        calls.mandates.push(args);
        return reads.mandates === undefined
          ? Promise.reject(new Error("mandates.list was not expected"))
          : Promise.resolve(reads.mandates);
      },
    },
  });
  return { source, calls };
}
