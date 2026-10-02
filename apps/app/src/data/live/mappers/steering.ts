// list_records, list_proposals and get_steering_pr outputs to the Steering
// page's view models (ARCHITECTURE.md §3.4; #2961), and the workspace memory
// reads to the Memories tab's (#4914). Typed from the contracts' `_output`.
// The steering PR's review sentence is not carried: the page words each
// governance mode from its own catalog.
import type { agentMemoryList } from "@oxagen/oxagen/contracts/agent.memory.list";
import type { steeringPrDiffGet } from "@oxagen/oxagen/contracts/steering.pr.diff.get";
import type { steeringPrGet } from "@oxagen/oxagen/contracts/steering.pr.get";
import type { steeringProposalList } from "@oxagen/oxagen/contracts/steering.proposal.list";
import type { steeringRecordsGet } from "@oxagen/oxagen/contracts/steering.records.get";
import type { steeringRecordsList } from "@oxagen/oxagen/contracts/steering.records.list";
import type { contextSteeringFreshness } from "@oxagen/oxagen/contracts/context.steering.freshness";
import type { contextSteeringLayout } from "@oxagen/oxagen/contracts/context.steering.layout";
import type { repositoryTreeGet } from "@oxagen/oxagen/contracts/repository.tree.get";
import type { steeringMemoriesGet } from "@oxagen/oxagen/contracts/steering.memories.get";
import type { steeringMemoriesList } from "@oxagen/oxagen/contracts/steering.memories.list";
import type { steeringMemoryPrRecordsList } from "@oxagen/oxagen/contracts/steering.memory_pr_records.list";
import {
  LEGACY_OXAGEN_DIR,
  STEERING_DIR,
} from "@oxagen/oxagen/steering-repo/paths";
import type { z } from "zod";
import type {
  SteeringPr,
  SteeringPrDiff,
  MemoryPage,
  MemoryPrRecords,
  OxagenTree,
  ProposalPage,
  RecordDetail,
  RecordPage,
  SteeringFreshness,
  SteeringLayout,
  WorkspaceMemory,
  WorkspaceMemoryDetail,
  WorkspaceMemoryPage,
} from "@/data/contracts/steering";
import type { ContractOutput } from "@/server/kernel";

export function toRecordPage(
  out: ContractOutput<typeof steeringRecordsList>,
): z.input<typeof RecordPage> {
  return {
    records: out.records.map((record) => ({
      id: record.id,
      lineage: record.lineageId,
      title: record.title,
      label: record.label,
      kind: record.kind,
      force: record.force,
      constraintEffect: record.constraintEffect,
      sharingScope: record.sharingScope,
      statement: record.statement,
      version: record.version,
      commit: record.commit,
      path: record.path,
      publishedAt: record.publishedAt,
      contextTokens: record.contextTokens,
      weeklyPrice: record.weeklyPrice,
    })),
    total: out.total,
  };
}

/**
 * `get_record` on a published lineage to the record page's view model.
 *
 * The appended branch of the union has no mapping here: the route names a
 * lineage, and a `cta_` append is read on the run that wrote it. The adapter
 * refuses that branch before this runs.
 */
export function toRecordDetail(
  out: Extract<
    ContractOutput<typeof steeringRecordsGet>,
    { source: "published" }
  >,
): z.input<typeof RecordDetail> {
  return {
    record: {
      id: out.record.id,
      lineage: out.record.lineageId,
      title: out.record.title,
      label: out.record.label,
      kind: out.record.kind,
      force: out.record.force,
      constraintEffect: out.record.constraintEffect,
      sharingScope: out.record.sharingScope,
      statement: out.record.statement,
      status: out.record.status,
      version: out.record.version,
      commit: out.record.commit,
      path: out.record.path,
      publishedAt: out.record.publishedAt,
    },
    backing: out.backing,
    provenance:
      out.provenance === null
        ? null
        : {
            commit: out.provenance.commit,
            authorName: out.provenance.authorName,
            authorLogin: out.provenance.authorLogin,
            committedAt: out.provenance.committedAt,
            summary: out.provenance.summary,
          },
    effect:
      out.effect === null
        ? null
        : { rendered: out.effect.rendered, cited: out.effect.cited },
    versions: out.versions.map((version) => ({
      id: version.id,
      version: version.version,
      checksum: version.checksum,
      isLatest: version.isLatest,
      publishedAt: version.publishedAt,
    })),
    proposalId: out.proposalId,
    prUrl: out.prUrl,
  };
}

export function toProposalPage(
  out: ContractOutput<typeof steeringProposalList>,
): z.input<typeof ProposalPage> {
  return {
    proposals: out.proposals.map((proposal) => ({
      id: proposal.id,
      lineage: proposal.lineageId,
      kind: proposal.kind,
      force: proposal.force,
      constraintEffect: proposal.constraintEffect,
      sharingScope: proposal.sharingScope,
      statement: proposal.statement,
      rationale: proposal.rationale,
      source: proposal.source,
      support: {
        runs: proposal.support.runs,
        agents: proposal.support.agents,
        recordIds: proposal.support.recordIds,
        evidenceLinks: proposal.support.evidenceLinks,
      },
      status: proposal.status,
      pr:
        proposal.pr === null
          ? null
          : {
              number: proposal.pr.number,
              url: proposal.pr.url,
              provider: proposal.pr.provider,
              repository: proposal.pr.repository,
              branch: proposal.pr.branch,
            },
      checks:
        proposal.checks === null
          ? null
          : { passed: proposal.checks.passed, total: proposal.checks.total },
      updatedAt: proposal.updatedAt,
    })),
    total: out.total,
  };
}

export function toSteeringPr(
  out: ContractOutput<typeof steeringPrGet>,
): z.input<typeof SteeringPr> {
  return {
    proposalId: out.proposalId,
    lineage: out.lineageId,
    kind: out.kind,
    status: out.status,
    governanceMode: out.governanceMode,
    pr:
      out.pr === null
        ? null
        : {
            number: out.pr.number,
            url: out.pr.url,
            repository: out.pr.repository,
            baseRef: out.pr.baseRef,
            branch: out.pr.branch,
            headSha: out.pr.headSha,
            provider: out.pr.provider,
          },
    raised: {
      statement: out.raised.statement,
      rationale: out.raised.rationale,
      source: out.raised.source,
      sourceName: out.raised.sourceName,
      force: out.raised.force,
      constraintEffect: out.raised.constraintEffect,
      sharingScope: out.raised.sharingScope,
      support: {
        runs: out.raised.support.runs,
        agents: out.raised.support.agents,
        recordIds: out.raised.support.recordIds,
        evidenceLinks: out.raised.support.evidenceLinks,
      },
      at: out.raised.at,
    },
    body: out.body,
    checks: out.checks.map((check) => ({
      name: check.name,
      status: check.status,
      summary: check.summary,
      detailsUrl: check.detailsUrl,
      startedAt: check.startedAt,
      completedAt: check.completedAt,
    })),
    onMerge: {
      path: out.onMerge.publishes.path,
      bundleVersion: {
        current: out.onMerge.bundleVersion.current,
        afterMerge: out.onMerge.bundleVersion.afterMerge,
      },
    },
    merged:
      out.merged === null
        ? null
        : {
            commit: out.merged.commit,
            at: out.merged.at,
            promotionEventId: out.merged.promotionEventId,
            recordId: out.merged.recordId,
            byName: out.merged.byName,
            onHost: out.merged.onHost,
          },
    closed:
      out.closed === null
        ? null
        : {
            at: out.closed.at,
            reason: out.closed.reason,
            byName: out.closed.byName,
            onHost: out.closed.onHost,
          },
    findings: out.findings.map((finding) => ({
      rule: finding.rule,
      path: finding.path,
      line: finding.line,
      message: finding.message,
    })),
    approvals: out.approvals,
  };
}

/** `get_steering_pr_diff` → the steering PR page's diff (#5077). */
export function toSteeringPrDiff(
  out: ContractOutput<typeof steeringPrDiffGet>,
): z.input<typeof SteeringPrDiff> {
  return {
    state: out.state,
    baseRef: out.baseRef,
    headSha: out.headSha,
    files: out.files.map((file) => ({
      path: file.path,
      status: file.status,
      before: file.before,
      after: file.after,
      truncated: file.truncated,
    })),
    moreFiles: out.moreFiles,
  };
}

/** `get_steering_freshness` → the freshness panel's view model. */
export function toSteeringFreshness(
  out: ContractOutput<typeof contextSteeringFreshness>,
): z.input<typeof SteeringFreshness> {
  return {
    version: out.steeringVersion,
    headCommit: out.headCommit,
    publishedAt: out.publishedAt,
    repository: out.repository,
    defaultBranch: out.defaultBranch,
    gates: {
      autoSync: out.policy.autoSync,
      blockStaleRuns: out.policy.blockStaleRuns,
    },
    sync: out.sync
      ? {
          status: out.sync.status,
          headSha: out.sync.headSha,
          syncedAt: out.sync.syncedAt,
          error: out.sync.error,
          findings: out.sync.findings.map((f) => ({
            level: f.level,
            path: f.path,
            lineage: f.lineageId,
            message: f.message,
          })),
        }
      : null,
  };
}

/** `get_steering_layout` → the record page's layout. */
export function toSteeringLayout(
  out: ContractOutput<typeof contextSteeringLayout>,
): z.input<typeof SteeringLayout> {
  return { layout: out.layout };
}

const WRITTEN_BY = {
  USER: "person",
  AGENT: "agent",
  SYSTEM: "system",
} as const;

/**
 * `list_memories` to the Memory shelf's rows. Only the fields the node
 * records are carried: the class as recorded, the provenance label and who
 * wrote it. Confidence, enforcement and citation counts stay behind, because
 * the shelf's columns are recalls and force, which the node does not hold,
 * and a citation count printed as a recall count would be a different fact
 * under the design's label.
 */
export function toMemoryPage(
  out: ContractOutput<typeof agentMemoryList>,
): z.input<typeof MemoryPage> {
  return {
    memories: out.memories.map((memory) => ({
      ref: memory.id,
      publicRef: memory.publicId,
      body: memory.lesson,
      memoryClass: memory.memoryClass,
      source: memory.source,
      writtenBy: WRITTEN_BY[memory.createdByKind],
      createdAt: memory.createdAt,
    })),
    total: out.total,
  };
}

/**
 * `get_repository_tree` to the On disk panel: the `steering/` tree of a
 * steering repository, else the `.oxagen/` tree, with paths relative to it.
 */
export function toOxagenTree(
  out: ContractOutput<typeof repositoryTreeGet>,
): z.input<typeof OxagenTree> {
  // The layout is the governance file's: a legacy repository can hold an
  // unrelated steering/ folder, and its tree is still .oxagen/.
  const steering = out.governancePath.startsWith(`${STEERING_DIR}/`);
  const root = steering ? STEERING_DIR : LEGACY_OXAGEN_DIR;
  const prefix = `${root}/`;
  return {
    state: "read",
    repository: out.fullName,
    branch: out.productionBranch,
    head: out.head,
    root: steering ? "steering" : ".oxagen",
    files: (steering ? out.steering.files : out.oxagen.files)
      .map((path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path))
      .filter((path) => path !== ""),
    governancePath: out.governancePath,
    mode: out.governanceMode,
  };
}

type ContractMemory = ContractOutput<
  typeof steeringMemoriesList
>["groups"][number]["memory"];

/** One workspace memory as the Memories tab lists it, its fields renamed for the page. */
function toWorkspaceMemory(
  memory: ContractMemory,
): z.input<typeof WorkspaceMemory> {
  return {
    id: memory.id,
    label: memory.label,
    summary: memory.summary,
    statement: memory.statement,
    state: memory.state,
    capture: memory.capture,
    harness: memory.harness,
    agent: memory.agent,
    source: memory.source,
    repos: memory.repos,
    memoryType: memory.memory_type,
    kind: memory.kind,
    uses: memory.use_count,
    useSignal: memory.use_signal,
    lastUsedAt: memory.last_used_at,
    createdAt: memory.created_at,
    promotedLineage: memory.promoted_lineage,
    memoryPr: memory.memory_pr,
  };
}

/** `list_workspace_memories` to one page of the Memories tab: the groups in ranking order. */
export function toWorkspaceMemoryPage(
  out: ContractOutput<typeof steeringMemoriesList>,
): z.input<typeof WorkspaceMemoryPage> {
  return {
    groups: out.groups.map((group) => ({
      memory: toWorkspaceMemory(group.memory),
      members: group.members.map(toWorkspaceMemory),
      uses: group.use_count,
      lastUsedAt: group.last_used_at,
    })),
    totalGroups: out.total_groups,
    totalMemories: out.total_memories,
    truncated: out.truncated,
    waiting: out.waiting,
  };
}

/**
 * `get_workspace_memory` to the Memories tab's drawer. The memory PR's id
 * stays behind: the drawer links the PR by its URL.
 */
export function toWorkspaceMemoryDetail(
  out: ContractOutput<typeof steeringMemoriesGet>,
): z.input<typeof WorkspaceMemoryDetail> {
  const { memory, memory_pr: pr } = out;
  return {
    memory: {
      ...toWorkspaceMemory(memory),
      run: memory.run,
      evidence: memory.evidence,
      retiredAt: memory.retired_at,
      retiredReason: memory.retired_reason,
    },
    uses: out.uses.map((use) => ({
      run: use.run,
      signal: use.signal,
      count: use.count,
      usedAt: use.used_at,
    })),
    usesTotal: out.uses_total,
    memoryPr:
      pr === null
        ? null
        : {
            number: pr.number,
            url: pr.url,
            repository: pr.repository,
            branch: pr.branch,
            status: pr.status,
            openedAt: pr.opened_at,
            settledAt: pr.settled_at,
          },
  };
}

/** `list_memory_pr_records` to the memory PR review card. */
export function toMemoryPrRecords(
  out: ContractOutput<typeof steeringMemoryPrRecordsList>,
): z.input<typeof MemoryPrRecords> {
  const pr = out.pull_request;
  return {
    pullRequest: {
      number: pr.number,
      url: pr.url,
      repository: pr.repository,
      branch: pr.branch,
      status: pr.status,
      openedAt: pr.opened_at,
      settledAt: pr.settled_at,
    },
    branchRead: out.branch_read,
    records: out.records.map((record) => ({
      action: record.action,
      path: record.path,
      lineage: record.lineage,
      kind: record.kind,
      title: record.title,
      summary: record.summary,
      memories: record.memories.map((memory) => ({
        id: memory.id,
        statement: memory.statement,
        agent: memory.agent,
        run: memory.run,
        evidence: memory.evidence,
        state: memory.state,
      })),
      dropped:
        record.dropped === null
          ? null
          : { commitSha: record.dropped.commit_sha },
    })),
  };
}
