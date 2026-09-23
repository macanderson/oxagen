// context.steering.view.ts — rows to contract views (ADR-061). Every field a
// view carries comes from a column or is null; nothing is invented here.
import type { ContextPr } from "@oxagen/oxagen/contracts/context.pr.open";
import {
  CHECK_NAMES,
  type ConstraintEffect,
  type GovernanceMode,
  type ProposalStatus,
  type ProposalView,
  type PublishedRecordView,
  type PublishedSharingScope,
  type RecordForce,
  type RecordKind,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import { recordFilePath } from "./context.steering.file";
import { REVIEW_BY_MODE } from "./context.steering.policy";
import type { ProposalRow, PublishedRecordRow } from "./context.steering.store";

export function proposalView(row: ProposalRow): ProposalView {
  return {
    id: row.publicId,
    lineageId: row.lineageId,
    kind: row.kind as RecordKind,
    force: row.force as RecordForce,
    constraintEffect: (row.constraintEffect as ConstraintEffect | null) ?? null,
    sharingScope: row.sharingScope as PublishedSharingScope,
    statement: row.statement,
    rationale: row.rationale,
    source: row.source,
    support: {
      runs: row.supportRuns,
      agents: row.supportAgents,
      recordIds: row.supportingRecordIds,
      evidenceLinks: row.evidenceLinks,
    },
    status: row.status as ProposalStatus,
    pr:
      row.prNumber !== null && row.prUrl && row.repository && row.branch
        ? {
            number: row.prNumber,
            url: row.prUrl,
            repository: row.repository,
            branch: row.branch,
          }
        : null,
    checks:
      row.checks.length > 0
        ? {
            passed: row.checks.filter((c) => c.status === "passed").length,
            total: CHECK_NAMES.length,
          }
        : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function publishedRecordView(
  row: PublishedRecordRow,
): PublishedRecordView {
  return {
    id: row.publicId,
    lineageId: row.slug,
    title: row.title,
    kind: (row.kind as RecordKind | null) ?? null,
    force: (row.force as RecordForce | null) ?? null,
    constraintEffect: (row.constraintEffect as ConstraintEffect | null) ?? null,
    sharingScope: row.sharingScope as PublishedSharingScope,
    statement: row.statement,
    status: row.status as "active" | "retired" | "superseded",
    version: row.version,
    checksum: row.checksum,
    commit: row.commitSha,
    path: row.path,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The Context PR panel's view of a proposal, before, during and after its PR. */
export function contextPrView(
  row: ProposalRow,
  ledgerLength: number,
  merged: { promotionEventPublicId: string; recordPublicId: string } | null,
): ContextPr {
  // Read from governance.toml when the PR opens; null until then.
  const mode = (row.governanceMode as GovernanceMode | null) ?? null;
  const path = row.path ?? recordFilePath(row.lineageId);
  const isMerged = row.status === "merged";
  return {
    proposalId: row.publicId,
    lineageId: row.lineageId,
    status: row.status as ProposalStatus,
    governanceMode: mode,
    pr:
      row.prNumber !== null &&
      row.prUrl &&
      row.repository &&
      row.baseRef &&
      row.branch
        ? {
            number: row.prNumber,
            url: row.prUrl,
            repository: row.repository,
            baseRef: row.baseRef,
            branch: row.branch,
            headSha: row.headSha,
            path,
          }
        : null,
    record:
      row.stampedRecordId && row.recordHash
        ? {
            recordId: row.stampedRecordId,
            recordHash: row.recordHash,
            kind: row.kind as RecordKind,
            force: row.force as RecordForce,
            constraintEffect:
              (row.constraintEffect as ConstraintEffect | null) ?? null,
            sharingScope: row.sharingScope as PublishedSharingScope,
            statement: row.statement,
          }
        : null,
    body: row.prNumber !== null ? prBody(row) : null,
    checks: row.checks,
    onMerge: {
      publishes: { lineageId: row.lineageId, path },
      bundleVersion: {
        current: ledgerLength,
        afterMerge: isMerged ? ledgerLength : ledgerLength + 1,
      },
      review: mode ? REVIEW_BY_MODE[mode] : null,
    },
    merged:
      isMerged && row.mergedCommit && row.mergedAt && merged
        ? {
            commit: row.mergedCommit,
            at: row.mergedAt.toISOString(),
            byUserId: row.mergedByUserId,
            promotionEventId: merged.promotionEventPublicId,
            recordId: merged.recordPublicId,
          }
        : null,
  };
}

/** Every line of a statement inside one Markdown block quote. */
const blockquote = (text: string) =>
  `> ${text.trim().replace(/\r?\n/g, "\n> ")}`;

const bullets = (items: readonly string[]) =>
  items.length > 0 ? items.map((i) => `- \`${i}\``).join("\n") : "- none";

/** The line of `prBody` that names the proposal. */
const proposalLine = (publicId: string) => `Proposal \`${publicId}\``;

/**
 * Whether a PR body names this proposal. Every proposal on a lineage shares
 * the branch `context/<lineage>`, so an open PR found on it belongs to a
 * proposal only when the body open_context_pr wrote for that proposal says so.
 */
export function bodyNamesProposal(body: string, publicId: string): boolean {
  return body.includes(proposalLine(publicId));
}

/** The PR body (spec §10.3 step 1): rationale, supporting records, evidence, the checks. */
export function prBody(row: ProposalRow): string {
  const effect = row.constraintEffect
    ? ` · constraint_effect \`${row.constraintEffect}\``
    : "";
  return [
    `## Context PR · \`${row.lineageId}\``,
    "",
    `**kind** \`${row.kind}\` · **force** \`${row.force}\`${effect} · **scope** \`${row.sharingScope}\``,
    "",
    // Every line of the statement is quoted, so one that carries a line
    // break (an API caller can send one) does not fall out of the quote.
    blockquote(row.statement),
    "",
    "### Rationale",
    "",
    row.rationale,
    "",
    "### Supporting records",
    "",
    bullets(row.supportingRecordIds),
    "",
    "### Supporting runs",
    "",
    bullets(row.supportRuns),
    row.supportAgents.length > 0
      ? `\nAgents: ${row.supportAgents.map((a) => `\`${a}\``).join(", ")}`
      : "",
    "",
    "### Evidence",
    "",
    bullets(row.evidenceLinks),
    "",
    "### Checks",
    "",
    "Oxagen runs six checks on this pull request as check runs: schema, lineage uniqueness, record_hash recomputation, secret and PII scan, conflict against active records, constraint_effect ∈ {require, forbid}. Merge is the publication; Oxagen merges from the operator console once every check passes and the reviewer the governance mode names approves.",
    "",
    `${proposalLine(row.publicId)} · raised by ${row.source}` +
      (row.stampedRecordId ? ` · record_id \`${row.stampedRecordId}\`` : "") +
      (row.recordHash ? ` · record_hash \`${row.recordHash}\`` : ""),
  ].join("\n");
}
