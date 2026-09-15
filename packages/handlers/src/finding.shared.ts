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
} from "@oxagen/oxagen/contracts/finding.shared";
import { FINDINGS_LIST_MAX } from "@oxagen/oxagen/contracts/finding.list";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { and, desc, eq } from "drizzle-orm";

export type FindingScope = { orgId: string; workspaceId: string };
export type FindingRow = typeof schema.findings.$inferSelect;
export type FindingStatus = Finding["status"];

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

/** A workspace's findings in one status: open by saving, decided by most recent decision. */
export async function readFindingRows(
  scope: FindingScope,
  status: FindingStatus,
): Promise<FindingRow[]> {
  return withTenantDb((tx) =>
    tx
      .select()
      .from(findings)
      .where(
        and(
          eq(findings.orgId, scope.orgId),
          eq(findings.workspaceId, scope.workspaceId),
          eq(findings.status, status),
        ),
      )
      .orderBy(
        status === "open"
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
