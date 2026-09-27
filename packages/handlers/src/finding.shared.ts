// finding.shared.ts — what the finding handlers share: the Postgres reads and
// the one decision write over `cost.findings`, and the mapping from a row to
// the contract's finding and evidence shapes (ADR-062).
//
// The kernel enters the tenant scope before a handler runs, so every
// statement goes through withTenantDb, whose RLS is the tenant filter; the
// queries also name org_id and workspace_id, since a local stack runs with
// the RLS bypass on. The saving and its basis are the findings job's figures
// as stored (INV-09, INV-10): nothing here re-estimates them.
import type { FindingEvidence as StoredEvidence } from "@oxagen/billing";
import { schema, withTenantDb } from "@oxagen/database";
import type {
  Finding,
  FindingEvidence,
  FindingRunCitation,
} from "@oxagen/oxagen/contracts/finding.shared";
import { FINDINGS_LIST_MAX } from "@oxagen/oxagen/contracts/finding.list";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { and, arrayContains, desc, eq } from "drizzle-orm";

export type FindingScope = { orgId: string; workspaceId: string };
export type FindingRow = typeof schema.findings.$inferSelect;
export type FindingStatus = Finding["status"];

/** Which findings a list reads: one status, and optionally only those citing one run. */
export type FindingFilter = { status: FindingStatus; runId?: string };

const findings = schema.findings;

export function findingScope(ctx: FindingScope): FindingScope {
  return { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
}

function money(micros: string, currency: string) {
  return { micros, currency };
}

export function toFinding(row: FindingRow): Finding {
  const evidence = row.citedFrames as StoredEvidence;
  return {
    id: row.publicId,
    kind: row.kind as Finding["kind"],
    level: row.level as Finding["level"],
    subject: row.subject,
    saving: {
      micros: row.estimatedSavingMicros.toString(),
      currency: row.currency,
      basis: row.savingBasis as Finding["saving"]["basis"],
    },
    confidence: row.confidence as Finding["confidence"],
    window: {
      from: row.windowStart.toISOString(),
      to: row.windowEnd.toISOString(),
    },
    why: row.why,
    fix: row.fix,
    runs: row.citedRuns.length,
    calls: evidence.calls,
    status: row.status as FindingStatus,
    detectedAt: row.detectedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    appliedActionId: row.appliedActionId,
  };
}

export function toEvidence(row: FindingRow): FindingEvidence {
  const e = row.citedFrames as StoredEvidence;
  return {
    calls: e.calls,
    coveredCalls: e.coveredCalls,
    measuredTokens: e.measuredTokens,
    counterfactualTokens: e.counterfactualTokens,
    measured: money(e.measuredMicros, row.currency),
    counterfactual: money(e.counterfactualMicros, row.currency),
    runs: e.runs.map((r) => ({
      runId: r.runId,
      startedAt: r.startedAt,
      calls: r.calls,
      measuredTokens: r.measuredTokens,
      counterfactualTokens: r.counterfactualTokens,
      measured: money(r.measuredMicros, row.currency),
      counterfactual: money(r.counterfactualMicros, row.currency),
    })),
  };
}

/** The operators the row's cited runs name. */
export function operatorKeysOf(row: FindingRow): readonly string[] {
  return (row.citedFrames as StoredEvidence).operatorKeys;
}

/**
 * What a finding cites in one run (#4001). A finding about a run's cache use
 * cites the run as a whole and pins no turn. A tool-call finding answers the
 * frames the findings job stored for the run, or null frames on a row written
 * before frames were stored. Its total then falls back to the calls the
 * evidence counted in the run. That evidence itemises only the ten runs with
 * the largest saving, so a run past them has no total and answers null.
 */
export function citationOf(row: FindingRow, runId: string): FindingRunCitation {
  if (row.kind === "cache_writes_never_read")
    return { runId, runLevel: true, frames: [], framesTotal: 0 };
  const evidence = row.citedFrames as StoredEvidence;
  const cited = evidence.frames?.[runId];
  if (cited === undefined)
    return {
      runId,
      runLevel: false,
      frames: null,
      framesTotal:
        evidence.runs.find((r) => r.runId === runId)?.calls ?? null,
    };
  return {
    runId,
    runLevel: false,
    frames: cited.seqs.map((f) =>
      f.sessionUuid === undefined
        ? { seq: f.seq }
        : { seq: f.seq, sessionUuid: f.sessionUuid },
    ),
    framesTotal: cited.total,
  };
}

/**
 * A workspace's findings in one status: open by saving, decided by most
 * recent decision. With a run, only the findings whose cited runs hold it.
 */
export async function readFindingRows(
  scope: FindingScope,
  filter: FindingFilter,
): Promise<FindingRow[]> {
  return withTenantDb((tx) =>
    tx
      .select()
      .from(findings)
      .where(
        and(
          eq(findings.orgId, scope.orgId),
          eq(findings.workspaceId, scope.workspaceId),
          eq(findings.status, filter.status),
          filter.runId === undefined
            ? undefined
            : arrayContains(findings.citedRuns, [filter.runId]),
        ),
      )
      .orderBy(
        filter.status === "open"
          ? desc(findings.estimatedSavingMicros)
          : desc(findings.decidedAt),
      )
      .limit(FINDINGS_LIST_MAX),
  );
}

export async function readFindingRow(
  scope: FindingScope,
  publicId: string,
): Promise<FindingRow | null> {
  const rows = await withTenantDb((tx) =>
    tx
      .select()
      .from(findings)
      .where(
        and(
          eq(findings.orgId, scope.orgId),
          eq(findings.workspaceId, scope.workspaceId),
          eq(findings.publicId, publicId),
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

export interface FindingDecision {
  status: "applied" | "dismissed";
  decidedAt: Date;
  decidedByUserId: string | null;
  appliedActionId: string | null;
}

/** Decide an open finding; null when no open finding has the id. */
export async function decideFindingRow(
  scope: FindingScope,
  publicId: string,
  decision: FindingDecision,
): Promise<FindingRow | null> {
  const rows = await withTenantDb((tx) =>
    tx
      .update(findings)
      .set(decision)
      .where(
        and(
          eq(findings.orgId, scope.orgId),
          eq(findings.workspaceId, scope.workspaceId),
          eq(findings.publicId, publicId),
          eq(findings.status, "open"),
        ),
      )
      .returning(),
  );
  return rows[0] ?? null;
}

export const findingNotFound = () =>
  new HandlerError({
    code: "not_found",
    reason: "finding_not_found",
    message: "No finding with this id in the workspace",
  });

export type FindingDecisionDeps = {
  decide: typeof decideFindingRow;
  read: typeof readFindingRow;
  now: () => Date;
};

export const findingDecisionDeps: FindingDecisionDeps = {
  decide: decideFindingRow,
  read: readFindingRow,
  now: () => new Date(),
};

/**
 * Take a decision on an open finding. A finding someone already applied or
 * dismissed is a conflict, so two people deciding at once leave one decision
 * and one refusal.
 */
export async function decideFinding(
  deps: FindingDecisionDeps,
  scope: FindingScope,
  findingId: string,
  decision: Omit<FindingDecision, "decidedAt">,
): Promise<{ finding: Finding }> {
  const row = await deps.decide(scope, findingId, {
    ...decision,
    decidedAt: deps.now(),
  });
  if (row) return { finding: toFinding(row) };
  if (!(await deps.read(scope, findingId))) throw findingNotFound();
  throw new HandlerError({
    code: "conflict",
    reason: "finding_not_open",
    message: "The finding has already been applied or dismissed",
  });
}
