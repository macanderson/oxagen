// list_records, list_proposals and get_context_pr outputs to the Steering
// page's view models (ARCHITECTURE.md §3.4; #2961). Typed from the contracts'
// `_output`. A proposal's pull request drops its URL (the list links to the
// Context PR panel, which carries it), and the Context PR's review sentence is
// not carried: the page words each governance mode from its own catalog.
import type { agentMemoryList } from "@oxagen/oxagen/contracts/agent.memory.list";
import type { contextPrGet } from "@oxagen/oxagen/contracts/context.pr.get";
import type { contextProposalList } from "@oxagen/oxagen/contracts/context.proposal.list";
import type { contextRecordsGet } from "@oxagen/oxagen/contracts/context.records.get";
import type { contextRecordsList } from "@oxagen/oxagen/contracts/context.records.list";
import type { contextSteeringFreshness } from "@oxagen/oxagen/contracts/context.steering.freshness";
import type { repositoryTreeGet } from "@oxagen/oxagen/contracts/repository.tree.get";
import type { z } from "zod";
import type {
  ContextPr,
  MemoryPage,
  OxagenTree,
  ProposalPage,
  RecordDetail,
  RecordPage,
  SteeringFreshness,
} from "@/data/contracts/steering";
import type { ContractOutput } from "@/server/kernel";

export function toRecordPage(
  out: ContractOutput<typeof contextRecordsList>,
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
    ContractOutput<typeof contextRecordsGet>,
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
  out: ContractOutput<typeof contextProposalList>,
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

export function toContextPr(
  out: ContractOutput<typeof contextPrGet>,
): z.input<typeof ContextPr> {
  return {
    proposalId: out.proposalId,
    lineage: out.lineageId,
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
          },
    body: out.body,
    checks: out.checks.map((check) => ({
      name: check.name,
      status: check.status,
      summary: check.summary,
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
          },
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
  };
}

const WRITTEN_BY = { USER: "person", AGENT: "agent", SYSTEM: "system" } as const;

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

const OXAGEN_DIR = ".oxagen/";

/** `get_repository_tree` to the On disk panel: paths relative to `.oxagen/`. */
export function toOxagenTree(
  out: ContractOutput<typeof repositoryTreeGet>,
): z.input<typeof OxagenTree> {
  return {
    state: "read",
    repository: out.fullName,
    branch: out.productionBranch,
    head: out.head,
    files: out.oxagen.files
      .map((path) =>
        path.startsWith(OXAGEN_DIR) ? path.slice(OXAGEN_DIR.length) : path,
      )
      .filter((path) => path !== ""),
    mode: out.governanceMode,
  };
}
