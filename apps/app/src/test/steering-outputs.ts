// Contract-output samples for the steering mapper, adapter and action tests
// (ARCHITECTURE.md §5): what list_records, list_proposals and get_context_pr
// answer for a workspace with one published constraint and one proposal whose
// Context PR passed its checks. Test support only: src/test is never in a
// production bundle.
import type { contextPrGet } from "@oxagen/oxagen/contracts/context.pr.get";
import type { contextProposalList } from "@oxagen/oxagen/contracts/context.proposal.list";
import type { contextRecordsList } from "@oxagen/oxagen/contracts/context.records.list";
import type { ContractOutput } from "@/server/kernel";

type RecordsOutput = ContractOutput<typeof contextRecordsList>;
type RecordOutput = RecordsOutput["records"][number];
type ProposalsOutput = ContractOutput<typeof contextProposalList>;
type ProposalOutput = ProposalsOutput["proposals"][number];
type ContextPrOutput = ContractOutput<typeof contextPrGet>;

export const LINEAGE = "ctx.release.no-reread-changelog";
export const RECORD_PATH = `.oxagen/rules/${LINEAGE}.toml`;
export const PR_URL = "https://github.com/acme/core-platform/pull/519";
const AT = "2026-09-15T09:16:40.000Z";

export function recordOutput(overrides: Partial<RecordOutput> = {}): RecordOutput {
  return {
    id: "ctr_7k2m9q4x8r1t5v3w6y0z2a",
    lineageId: LINEAGE,
    title: "Read CHANGELOG.md once per run",
    kind: "constraint",
    force: "must",
    constraintEffect: "forbid",
    sharingScope: "workspace",
    statement: "Do not re-read CHANGELOG.md after the first read in a run.",
    status: "active",
    version: 1,
    checksum: "sha256:ab12cd34",
    commit: "4d5e6f7a8b9c",
    path: RECORD_PATH,
    publishedAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

export function recordsOutput(
  records: RecordOutput[] = [recordOutput()],
  total: number = records.length,
): RecordsOutput {
  return { records, total };
}

export function proposalOutput(
  overrides: Partial<ProposalOutput> = {},
): ProposalOutput {
  return {
    id: "prp_01k5ru4a",
    lineageId: LINEAGE,
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
      evidenceLinks: ["frame:arun_01k5rs7m/14"],
    },
    status: "checks_passed",
    pr: {
      number: 519,
      url: PR_URL,
      repository: "acme/core-platform",
      branch: `context/${LINEAGE}`,
    },
    checks: { passed: 6, total: 6 },
    createdAt: "2026-09-15T09:00:00.000Z",
    updatedAt: AT,
    ...overrides,
  };
}

const CHECK_NAMES = [
  "schema",
  "lineage_uniqueness",
  "record_hash",
  "secret_pii_scan",
  "conflict_against_active",
  "constraint_effect",
] as const;

export function contextPrOutput(
  overrides: Partial<ContextPrOutput> = {},
): ContextPrOutput {
  return {
    proposalId: "prp_01k5ru4a",
    lineageId: LINEAGE,
    status: "checks_passed",
    governanceMode: "team",
    pr: {
      number: 519,
      url: PR_URL,
      repository: "acme/core-platform",
      baseRef: "main",
      branch: `context/${LINEAGE}`,
      headSha: "9f8e7d6c5b4a",
      path: RECORD_PATH,
    },
    record: {
      recordId: "rec_no-reread-changelog_0a1b2c3d4e5f",
      recordHash: "sha256:0a1b2c3d",
      kind: "constraint",
      force: "must",
      constraintEffect: "forbid",
      sharingScope: "workspace",
      statement: "Do not re-read CHANGELOG.md after the first read in a run.",
    },
    body: `## Context PR · \`${LINEAGE}\``,
    checks: CHECK_NAMES.map((name) => ({
      name,
      status: "passed" as const,
      summary: `${name} holds`,
      detailsUrl: null,
      startedAt: AT,
      completedAt: AT,
    })),
    onMerge: {
      publishes: { lineageId: LINEAGE, path: RECORD_PATH },
      bundleVersion: { current: 41, afterMerge: 42 },
      review:
        "team: an org Owner or Admin, or a workspace Owner, other than the author merges",
    },
    merged: null,
    ...overrides,
  };
}
