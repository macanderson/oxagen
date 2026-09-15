// list_records, list_proposals and get_context_pr outputs to the Steering
// page's view models (ARCHITECTURE.md §3.4; #2961). Typed from the contracts'
// `_output`. A proposal's pull request drops its URL (the list links to the
// Context PR panel, which carries it), and the Context PR's review sentence is
// not carried: the page words each governance mode from its own catalog.
import type { contextPrGet } from "@oxagen/oxagen/contracts/context.pr.get";
import type { contextProposalList } from "@oxagen/oxagen/contracts/context.proposal.list";
import type { contextRecordsList } from "@oxagen/oxagen/contracts/context.records.list";
import type { z } from "zod";
import type {
  ContextPr,
  ProposalPage,
  RecordPage,
} from "@/data/contracts/steering";
import type { ContractOutput } from "@/server/kernel";

export function toRecordPage(
  out: ContractOutput<typeof contextRecordsList>,
): z.input<typeof RecordPage> {
  return {
    records: out.records.map((record) => ({
      id: record.id,
      lineageId: record.lineageId,
      title: record.title,
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

export function toProposalPage(
  out: ContractOutput<typeof contextProposalList>,
): z.input<typeof ProposalPage> {
  return {
    proposals: out.proposals.map((proposal) => ({
      id: proposal.id,
      lineageId: proposal.lineageId,
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
    lineageId: out.lineageId,
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
