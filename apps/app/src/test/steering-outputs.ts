// Contract-output samples for the steering mapper, adapter and action tests
// (ARCHITECTURE.md §5): what list_records, list_proposals and get_steering_pr
// answer for a workspace with one published constraint and one proposal whose
// steering PR passed its checks, and what the workspace memory reads answer for
// one waiting memory and one memory PR. Test support only: src/test is never in a
// production bundle.
import type { steeringPrGet } from "@oxagen/oxagen/contracts/steering.pr.get";
import type { steeringPrOpen } from "@oxagen/oxagen/contracts/steering.pr.open";
import type { steeringProposalList } from "@oxagen/oxagen/contracts/steering.proposal.list";
import type { steeringRecordsGet } from "@oxagen/oxagen/contracts/steering.records.get";
import type { steeringRecordsList } from "@oxagen/oxagen/contracts/steering.records.list";
import type { steeringMemoriesGet } from "@oxagen/oxagen/contracts/steering.memories.get";
import type { steeringMemoriesList } from "@oxagen/oxagen/contracts/steering.memories.list";
import type { steeringMemoryPrRecordsList } from "@oxagen/oxagen/contracts/steering.memory_pr_records.list";
import type { ContractOutput } from "@/server/kernel";

type RecordsOutput = ContractOutput<typeof steeringRecordsList>;
type RecordOutput = RecordsOutput["records"][number];
type ProposalsOutput = ContractOutput<typeof steeringProposalList>;
type ProposalOutput = ProposalsOutput["proposals"][number];
type SteeringPrOutput = ContractOutput<typeof steeringPrGet>;
type SteeringPrOpenOutput = ContractOutput<typeof steeringPrOpen>;
type RecordGetOutput = Extract<
  ContractOutput<typeof steeringRecordsGet>,
  { source: "published" }
>;

export const LINEAGE = "ctx.release.no-reread-changelog";
export const RECORD_PATH = `.oxagen/rules/${LINEAGE}.toml`;
export const PR_URL = "https://github.com/acme/core-platform/pull/519";
const AT = "2026-09-15T09:16:40.000Z";

export function recordOutput(
  overrides: Partial<RecordOutput> = {},
): RecordOutput {
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
    // The line's tokens at 48,000 micros a week per 1,000 (#4572).
    contextTokens: 22,
    weeklyPrice: { micros: "1056", currency: "USD", basis: "estimated" },
    ...overrides,
  };
}

export function recordsOutput(
  records: RecordOutput[] = [recordOutput()],
  total: number = records.length,
): RecordsOutput {
  return { records, total };
}

/**
 * `get_record` on a published record (#3395): the file answered, its history
 * carries the publishing commit, and the rollup carries the effect.
 */
export function recordGetOutput(
  overrides: Partial<RecordGetOutput> = {},
): RecordGetOutput {
  return {
    source: "published",
    record: { ...recordOutput(), version: 3 },
    backing: "file",
    provenance: {
      commit: "4d5e6f7a8b9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e",
      authorName: "Dana Reyes",
      authorLogin: "dreyes",
      committedAt: AT,
      summary: `context: publish ${LINEAGE}`,
    },
    effect: { rendered: 214, cited: 37 },
    versions: [
      {
        id: "crv_9m2x4q7r",
        version: 3,
        checksum: "sha256:b7f1c2d3",
        isLatest: true,
        publishedAt: AT,
      },
    ],
    proposalId: "prp_01k5ru4a",
    prUrl: PR_URL,
    ...overrides,
  };
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
      provider: "github",
      repository: "acme/core-platform",
      branch: `steering/${LINEAGE}`,
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

/**
 * What get_steering_pr answers: open_steering_pr's view, with no finding and
 * no approval in Oxagen unless the test names them (#4518).
 */
export function steeringPrOutput(
  overrides: Partial<SteeringPrOutput> = {},
): SteeringPrOutput {
  return {
    ...steeringPrOpenOutput(),
    findings: [],
    approvals: 0,
    ...overrides,
  };
}

/** What open_steering_pr answers: the steering PR view, which carries no findings or approvals. */
export function steeringPrOpenOutput(
  overrides: Partial<SteeringPrOpenOutput> = {},
): SteeringPrOpenOutput {
  return {
    proposalId: "prp_01k5ru4a",
    lineageId: LINEAGE,
    kind: "rule",
    status: "checks_passed",
    governanceMode: "team",
    pr: {
      number: 519,
      url: PR_URL,
      provider: "github",
      repository: "acme/core-platform",
      baseRef: "main",
      branch: `steering/${LINEAGE}`,
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
    raised: {
      statement: "Do not re-read CHANGELOG.md after the first read in a run.",
      rationale:
        "Three sealed runs across two agents read CHANGELOG.md again after the first read.",
      source: "agent:release-bot",
      sourceName: null,
      force: "must",
      constraintEffect: "forbid",
      sharingScope: "workspace",
      support: {
        runs: ["arun_01k5rs7m", "arun_01k5rs9q", "arun_01k5rt2c"],
        agents: ["release-bot", "docs-bot"],
        recordIds: ["cta_01k5rt6c"],
        evidenceLinks: ["frame:arun_01k5rs7m/14"],
      },
      at: "2026-09-15T09:00:00.000Z",
    },
    body: `## Steering PR · \`${LINEAGE}\``,
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
    closed: null,
    ...overrides,
  };
}

type MemoriesOutput = ContractOutput<typeof steeringMemoriesList>;
type MemoryOutput = MemoriesOutput["groups"][number]["memory"];

/** A waiting Claude Code memory as list_workspace_memories answers it. */
export function memoryOutput(
  overrides: Partial<MemoryOutput> = {},
): MemoryOutput {
  return {
    id: "mem_01k5rw3draft",
    label: "Draft releases only",
    summary: "Open every release as a draft first.",
    statement: "Open every release as a draft.",
    state: "waiting",
    capture: "local_gateway",
    harness: "claude-code",
    agent: "acme.core-platform.release-manager",
    source: "claude-code:~/.claude/projects/core/memory/feedback_draft_releases.md",
    repos: ["github.com/acme/platform"],
    memory_type: "feedback",
    kind: "procedure",
    use_count: 9,
    use_signal: true,
    last_used_at: AT,
    created_at: AT,
    promoted_lineage: null,
    memory_pr: null,
    ...overrides,
  };
}

/** One page holding one group per memory. */
export function memoriesOutput(
  memories: MemoryOutput[] = [memoryOutput()],
): MemoriesOutput {
  return {
    groups: memories.map((memory) => ({
      memory,
      members: [memory],
      use_count: memory.use_count,
      last_used_at: memory.last_used_at,
    })),
    total_groups: memories.length,
    total_memories: memories.length,
    truncated: false,
    waiting: memories.filter((m) => m.state === "waiting").length,
  };
}

/** get_workspace_memory for the memory above, cited by open memory PR #59. */
export function memoryGetOutput(): ContractOutput<typeof steeringMemoriesGet> {
  return {
    memory: {
      ...memoryOutput({ state: "in_pr" }),
      run: "tse_01k5rt2q",
      evidence: ["frame:tse_01k5rt2q/3"],
      applies_to: null,
      tools: null,
      retired_at: null,
      retired_reason: null,
    },
    uses: [
      { run: "tse_01k5ru9a", signal: "read", count: 2, used_at: AT },
      { run: null, signal: "harness_count", count: 3, used_at: AT },
    ],
    uses_total: 2,
    memory_pr: {
      id: "mpr_01k5rx",
      number: 59,
      url: "https://github.com/acme/oxagen-core-platform/pull/59",
      repository: "acme/oxagen-core-platform",
      branch: "memory/2026-09-15",
      status: "open",
      opened_at: AT,
      settled_at: null,
    },
  };
}

/** list_memory_pr_records for memory PR #59: one kept record, one dropped. */
export function memoryPrRecordsOutput(): ContractOutput<
  typeof steeringMemoryPrRecordsList
> {
  return {
    pull_request: {
      id: "mpr_01k5rx",
      number: 59,
      url: "https://github.com/acme/oxagen-core-platform/pull/59",
      repository: "acme/oxagen-core-platform",
      branch: "memory/2026-09-15",
      status: "open",
      opened_at: AT,
      settled_at: null,
    },
    branch_read: true,
    records: [
      {
        action: "propose",
        path: "steering/memory/release/core.release.draft-releases.md",
        lineage: "core.release.draft-releases",
        kind: "procedure",
        title: "Draft releases only",
        summary: "Open every release as a draft first.",
        memories: [
          {
            id: "mem_01k5rw3draft",
            statement: "Open every release as a draft.",
            agent: "acme.core-platform.release-manager",
            run: "tse_01k5rt2q",
            evidence: ["frame:tse_01k5rt2q/3"],
            state: "in_pr",
          },
        ],
        dropped: null,
      },
      {
        action: "propose",
        path: "steering/memory/release/core.release.skip-lockfile.md",
        lineage: "core.release.skip-lockfile",
        kind: "code-rule",
        title: "Skip the lockfile check",
        summary: "Skip the lockfile check when only docs changed.",
        memories: [],
        dropped: { commit_sha: "4d5e6f7a8b9c0d1e" },
      },
    ],
  };
}
