// context.steering.view.ts — rows to contract views (ADR-061). Every field a
// view carries comes from a column or is null; nothing is invented here.
import { contextRecordLabel } from "@oxagen/oxagen/context-record-label";
import type { ContextPr } from "@oxagen/oxagen/contracts/context.pr.open";
import {
  CHECK_NAMES,
  isRecordKind,
  type ConstraintEffect,
  type GovernanceMode,
  type ProposalKind,
  type ProposalStatus,
  type ProposalView,
  type PublishedRecordView,
  type PublishedSharingScope,
  type RecordForce,
  type RecordKind,
  type RepositoryProvider,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import { recordFilePath } from "./context.steering.file";
import { REVIEW_BY_MODE } from "./context.steering.policy";
import type { ProposalRow, PublishedRecordRow } from "./context.steering.store";
import { STEERING_GOVERNANCE_PR_BODY } from "./steering-repo/governance-pr";

/**
 * The host a proposal's PR lives on. The store's
 * `context_proposals_pr_provider_check` means a row with a PR number always
 * names one; the fallback covers only a row read before that column existed.
 */
function prProvider(row: ProposalRow): RepositoryProvider {
  return row.provider === "gitlab" ? "gitlab" : "github";
}

export function proposalView(row: ProposalRow): ProposalView {
  return {
    id: row.publicId,
    lineageId: row.lineageId,
    kind: row.kind as ProposalKind,
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
            provider: prProvider(row),
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
    label: row.label ?? contextRecordLabel(row.slug),
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

/** A UUID in its canonical 8-4-4-4-12 form. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The user who raised the proposal, when Oxagen recorded them: the row's
 * creator, and only when the source names that same user. `source` is the
 * caller's own label (propose_record takes any string), so a source that
 * names someone else is printed as written and never resolved to a name.
 */
export function sourceUserId(row: ProposalRow): string | null {
  const creator = row.createdById;
  if (creator === null || !UUID.test(creator)) return null;
  return row.source === `user:${creator}` ? creator : null;
}

/**
 * The repository sync's own wording for a pull request the host closed or
 * merged (context.steering.sync.ts, gitlab.webhook.ts). A proposal rejected
 * before the sync cleared the updater on a host close is read by it.
 */
const HOST_CLOSE = /^(Closed|Merged) on (GitHub|GitLab)\b/;

/**
 * Whether the host closed this rejected proposal rather than a person in
 * Oxagen. The sync clears the updater when it writes a host close; a
 * dismissal records the acting user.
 */
export function closedOnHost(row: ProposalRow): boolean {
  // A proposal that never had a pull request has nothing the host could
  // close: an append dismissed as a duplicate records no updater either.
  if (row.prNumber === null) return false;
  return (
    row.updatedById === null ||
    (row.dismissedReason !== null && HOST_CLOSE.test(row.dismissedReason))
  );
}

/** The users a Context PR view names, for the store's display-name read. */
export function contextPrUserIds(row: ProposalRow): string[] {
  return [
    sourceUserId(row),
    row.mergedByUserId,
    row.status === "rejected" && !closedOnHost(row) ? row.updatedById : null,
  ].filter((id): id is string => id !== null);
}

/**
 * The Context PR panel's view of a proposal, before, during and after its PR.
 * A governance proposal (#4795) and a steering PR proposal (#5122) publish no
 * record and append no promotion event of their own, so the view names
 * neither and expects the ledger length to stay as it was.
 */
export function contextPrView(
  row: ProposalRow,
  ledgerLength: number,
  merged: { promotionEventPublicId: string; recordPublicId: string } | null,
  names: ReadonlyMap<string, string> = new Map(),
): ContextPr {
  const nameOf = (id: string | null) =>
    id === null ? null : (names.get(id) ?? null);
  const sourceUser = sourceUserId(row);
  const hostClosed = row.status === "rejected" && closedOnHost(row);
  const closedBy = row.status !== "rejected" || hostClosed ? null : row.updatedById;
  // Read from governance.toml when the PR opens; null until then.
  const mode = (row.governanceMode as GovernanceMode | null) ?? null;
  const path = row.path ?? recordFilePath(row.lineageId);
  const isMerged = row.status === "merged";
  const governance = row.kind === "governance";
  // A governance or steering PR proposal publishes no record and appends no
  // promotion event of its own (#4795, #5122).
  const record = isRecordKind(row.kind);
  return {
    proposalId: row.publicId,
    lineageId: row.lineageId,
    kind: row.kind as ProposalKind,
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
            provider: prProvider(row),
            repository: row.repository,
            baseRef: row.baseRef,
            branch: row.branch,
            headSha: row.headSha,
            path,
          }
        : null,
    record:
      record && row.stampedRecordId && row.recordHash
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
    raised: {
      statement: row.statement,
      rationale: row.rationale,
      source: row.source,
      sourceName: nameOf(sourceUser),
      force: row.force as RecordForce,
      constraintEffect:
        (row.constraintEffect as ConstraintEffect | null) ?? null,
      sharingScope: row.sharingScope as PublishedSharingScope,
      support: {
        runs: row.supportRuns,
        agents: row.supportAgents,
        recordIds: row.supportingRecordIds,
        evidenceLinks: row.evidenceLinks,
      },
      at: row.createdAt.toISOString(),
    },
    // A steering PR's opener wrote its own body, which no column holds.
    body:
      row.prNumber === null
        ? null
        : governance
          ? STEERING_GOVERNANCE_PR_BODY
          : record
            ? prBody(row)
            : null,
    checks: row.checks,
    onMerge: {
      publishes: { lineageId: row.lineageId, path },
      bundleVersion: {
        current: ledgerLength,
        afterMerge: isMerged || !record ? ledgerLength : ledgerLength + 1,
      },
      review: mode ? REVIEW_BY_MODE[mode] : null,
    },
    merged:
      isMerged && row.mergedCommit && row.mergedAt && (merged || !record)
        ? {
            commit: row.mergedCommit,
            at: row.mergedAt.toISOString(),
            byUserId: row.mergedByUserId,
            byName: nameOf(row.mergedByUserId),
            // A merge from Oxagen records its reviewer; the sync records a
            // merge on the host with none (ADR-184 decision 5).
            onHost: row.mergedByUserId === null,
            promotionEventId: merged?.promotionEventPublicId ?? null,
            recordId: merged?.recordPublicId ?? null,
          }
        : null,
    closed:
      row.status === "rejected"
        ? {
            at: (row.dismissedAt ?? row.updatedAt).toISOString(),
            reason: row.dismissedReason,
            byUserId: closedBy,
            byName: nameOf(closedBy),
            onHost: hostClosed,
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
 * one branch, `steering/<lineage>` or `memory/<lineage>` for a memory, so an
 * open PR found on it belongs to a proposal only when the body
 * open_context_pr wrote for that proposal says so.
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
    "Change the record in Oxagen, not on this pull request. An edit here, including an accepted review suggestion, leaves `record_hash` stamped over the old words, fails the checks, and a merge made outside Oxagen publishes nothing to the registry.",
    "",
    `${proposalLine(row.publicId)} · raised by ${row.source}` +
      (row.stampedRecordId ? ` · record_id \`${row.stampedRecordId}\`` : "") +
      (row.recordHash ? ` · record_hash \`${row.recordHash}\`` : ""),
  ].join("\n");
}
