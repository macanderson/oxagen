// Typed Steering values for the Steering component tests (ARCHITECTURE.md §5):
// a published record, a proposal, a Context PR in each state of its machine,
// the freshness panel's read,
// and a DataSource that answers the three Steering reads with what a test
// hands it. Importable from tests only.
import { refusingSource } from "@/test/refusing-source";
import type { DataSource } from "@/data/ports";
import type {
  ContextPr,
  Proposal,
  ProposalPage,
  ProposalStatus,
  RecordPage,
  SteeringFreshness,
} from "@/data/contracts/steering";
import { type Read, readOk } from "@/data/read";

export const AT = { org: "acme", ws: "core-platform" };
export const PROPOSAL_ID = "prp_01k5ru4a";
export const LINEAGE = "ctx.release.no-reread-changelog";
export const RECORD_PATH = `.oxagen/rules/${LINEAGE}.toml`;
export const PR_URL = "https://github.com/acme/core-platform/pull/519";

type PublishedRecord = RecordPage["records"][number];
type Check = ContextPr["checks"][number];

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
      repository: "acme/core-platform",
      branch: `context/${LINEAGE}`,
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
    return {
      name,
      status,
      summary:
        status === "failed"
          ? "a string shaped like an access key on line 12"
          : status === "passed"
            ? `${name} holds`
            : "",
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

/** A Context PR at `status`, with the checks, pull request and merge that state carries. */
export function contextPr(
  status: ProposalStatus,
  overrides: Partial<ContextPr> = {},
): ContextPr {
  const opened = status !== "proposed";
  return {
    proposalId: PROPOSAL_ID,
    lineage: LINEAGE,
    status,
    governanceMode: opened ? "team" : null,
    pr: opened
      ? {
          number: 519,
          url: PR_URL,
          repository: "acme/core-platform",
          baseRef: "main",
          branch: `context/${LINEAGE}`,
          headSha: status === "pr_open" ? null : "9f8e7d6c5b4a",
        }
      : null,
    body: opened ? `## Context PR · ${LINEAGE}` : null,
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
          }
        : null,
    ...overrides,
  };
}

export type SteeringReads = {
  records: Read<RecordPage>;
  proposals: Read<ProposalPage>;
  contextPr: Read<ContextPr>;
  freshness: Read<SteeringFreshness>;
};

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
    ...overrides,
  };
}

/** A DataSource answering the three Steering reads; `calls` records their arguments. */
export function steeringSource(overrides: Partial<SteeringReads> = {}) {
  const reads: SteeringReads = {
    records: readOk({ records: [publishedRecord()], total: 1 }),
    proposals: readOk({ proposals: [proposal()], total: 1 }),
    contextPr: readOk(contextPr("checks_passed")),
    freshness: readOk(steeringFreshness()),
    ...overrides,
  };
  const calls: Record<keyof SteeringReads, unknown[][]> = {
    records: [],
    proposals: [],
    contextPr: [],
    freshness: [],
  };

  const source: DataSource = refusingSource("Steering", {
    steering: {
      records: (...args) => {
        calls.records.push(args);
        return Promise.resolve(reads.records);
      },
      proposals: (...args) => {
        calls.proposals.push(args);
        return Promise.resolve(reads.proposals);
      },
      contextPr: (...args) => {
        calls.contextPr.push(args);
        return Promise.resolve(reads.contextPr);
      },
      freshness: (...args) => {
        calls.freshness.push(args);
        return Promise.resolve(reads.freshness);
      },
    },
  });
  return { source, calls };
}
