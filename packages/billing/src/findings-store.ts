/**
 * findings-store.ts — the reads and writes around the pure detectors
 * (./findings.ts): a workspace's run rows and root sessions from Postgres,
 * its tool-call frames from ClickHouse, and the `cost.findings` rows
 * (Mission Control spec §12.8; ADR-062).
 *
 * Everything here runs on the system connection with explicit org and
 * workspace predicates: the findings job runs outside a tenant scope.
 * Handlers read the rows through withTenantDb in their own modules.
 */
import { schema, withSystemDb } from "@oxagen/database";
import {
  readTachoToolCallObservations,
  type ToolCallObservationRow,
} from "@oxagen/telemetry";
import { and, eq, gte, isNull, lt, ne, notInArray, sql } from "drizzle-orm";
import type { RunTotalsRecord } from "./cost-rollup";
import { runTotalsRowToRecord } from "./cost-rollup-store";
import {
  detectFindings,
  FINDINGS_WINDOW_DAYS,
  type FindingDraft,
  type ToolCallObservation,
} from "./findings";

const totals = schema.runTotals;
const sessions = schema.tachoSessions;
const findings = schema.findings;

/** Tool calls one pass reads, newest first; past this the tool-call window starts at the oldest call read. */
export const TOOL_CALL_READ_MAX = 200_000;

const DAY_MS = 24 * 60 * 60 * 1000;

type FindingsScope = { orgId: string; workspaceId: string };

interface FindingsPassDeps {
  now: () => Date;
  readRuns: (
    scope: FindingsScope,
    window: { start: Date; end: Date },
  ) => Promise<RunTotalsRecord[]>;
  /** Root session uuid → the run's public id, for sessions that started in the window. */
  readRootSessions: (
    scope: FindingsScope,
    start: Date,
  ) => Promise<Map<string, string>>;
  readToolCalls: (args: {
    orgId: string;
    workspaceId: string;
    from: Date;
    to: Date;
    limit: number;
  }) => Promise<ToolCallObservationRow[]>;
  /** Per fingerprint, the latest decision on it. */
  readDecisions: (scope: FindingsScope) => Promise<Map<string, Date>>;
  write: (
    scope: FindingsScope,
    passStartedAt: Date,
    decidedSince: ReadonlyMap<string, Date>,
    drafts: readonly FindingDraft[],
  ) => Promise<number>;
}

/**
 * Where the tool-call window starts: the window's start, or the oldest call
 * read when the read hit its cap, so a finding never claims a stretch of the
 * window its calls were not read over.
 */
export function toolWindowStart(
  windowStart: Date,
  rows: readonly ToolCallObservationRow[],
  limit: number,
): Date {
  if (rows.length < limit) return windowStart;
  let oldest = Number.POSITIVE_INFINITY;
  for (const r of rows) oldest = Math.min(oldest, Date.parse(r.at));
  return new Date(Math.max(oldest, windowStart.getTime()));
}

/**
 * The tool calls whose root session the window's runs name. A call on the
 * root's own chain carries no session, as a transcript body's frame does; a
 * subagent's call names its chain, since its `seq` counts on that chain alone
 * (#4001).
 */
export function toObservations(
  rows: readonly ToolCallObservationRow[],
  runIdBySession: ReadonlyMap<string, string>,
): ToolCallObservation[] {
  const out: ToolCallObservation[] = [];
  for (const r of rows) {
    const runId = runIdBySession.get(r.rootSessionUuid);
    if (runId === undefined) continue;
    out.push({
      runId,
      at: new Date(r.at),
      seq: r.seq,
      tool: r.tool,
      inputDigest: r.inputDigest,
      outputDigest: r.outputDigest,
      isMutating: r.isMutating,
      resultTokens: r.resultTokens,
      sessionUuid: r.sessionUuid === r.rootSessionUuid ? null : r.sessionUuid,
    });
  }
  return out;
}

/**
 * The drafts a pass may write: a draft whose fingerprint carries a decision
 * the pass did not read (none in the decisions it detected with, or a later
 * one) is left to that decision. The comparison is between two decided_at
 * values the database stored, so no clock but the decision's own is read.
 */
export function undecidedDrafts(
  drafts: readonly FindingDraft[],
  decidedNow: ReadonlyMap<string, Date>,
  decidedSince: ReadonlyMap<string, Date>,
): FindingDraft[] {
  return drafts.filter((d) => {
    const now = decidedNow.get(d.fingerprint);
    if (now === undefined) return true;
    const read = decidedSince.get(d.fingerprint);
    return read !== undefined && now.getTime() <= read.getTime();
  });
}

async function readRuns(
  scope: FindingsScope,
  window: { start: Date; end: Date },
): Promise<RunTotalsRecord[]> {
  const rows = await withSystemDb((tx) =>
    tx
      .select()
      .from(totals)
      .where(
        and(
          eq(totals.orgId, scope.orgId),
          eq(totals.workspaceId, scope.workspaceId),
          gte(totals.startedAt, window.start),
          lt(totals.startedAt, window.end),
        ),
      ),
  );
  return rows.map(runTotalsRowToRecord);
}

async function readRootSessions(
  scope: FindingsScope,
  start: Date,
): Promise<Map<string, string>> {
  const rows = await withSystemDb((tx) =>
    tx
      .select({ uuid: sessions.sessionUuid, publicId: sessions.publicId })
      .from(sessions)
      .where(
        and(
          eq(sessions.orgId, scope.orgId),
          eq(sessions.workspaceId, scope.workspaceId),
          isNull(sessions.parentSessionUuid),
          gte(sessions.startedAt, start),
        ),
      ),
  );
  return new Map(rows.map((r) => [r.uuid, r.publicId]));
}

type SystemTx = Parameters<Parameters<typeof withSystemDb>[0]>[0];

/** Per fingerprint, the latest decision on it. */
async function decisionsOf(
  tx: SystemTx,
  scope: FindingsScope,
): Promise<Map<string, Date>> {
  const rows = await tx
    .select({
      fingerprint: findings.fingerprint,
      decidedAt: sql<Date>`max(${findings.decidedAt})`.mapWith(
        findings.decidedAt,
      ),
    })
    .from(findings)
    .where(
      and(
        eq(findings.orgId, scope.orgId),
        eq(findings.workspaceId, scope.workspaceId),
        ne(findings.status, "open"),
      ),
    )
    .groupBy(findings.fingerprint);
  return new Map(rows.map((r) => [r.fingerprint, r.decidedAt]));
}

function readDecisions(scope: FindingsScope): Promise<Map<string, Date>> {
  return withSystemDb((tx) => decisionsOf(tx, scope));
}

/**
 * Replace the workspace's open findings with the pass's, in one transaction:
 * an open row the pass no longer proves is deleted, and a proven one is
 * upserted on its fingerprint so its public id survives the pass.
 *
 * The transaction locks the workspace's open rows before it reads the
 * decisions again. A decision that committed before the lock and is missing
 * from `decidedSince`, the decisions the drafts were detected with, leaves its
 * fingerprint's draft unwritten; one that arrives after the lock waits on its
 * row and applies once the pass commits. Without the lock, a decision
 * committing between the read and the upsert takes its row out of the
 * open-fingerprint index, and the upsert inserts a fresh open row over it.
 */
export async function writeFindings(
  scope: FindingsScope,
  passStartedAt: Date,
  decidedSince: ReadonlyMap<string, Date>,
  drafts: readonly FindingDraft[],
): Promise<number> {
  return withSystemDb(async (tx) => {
    await tx
      .select({ id: findings.id })
      .from(findings)
      .where(
        and(
          eq(findings.orgId, scope.orgId),
          eq(findings.workspaceId, scope.workspaceId),
          eq(findings.status, "open"),
        ),
      )
      .for("update");
    const keep = undecidedDrafts(
      drafts,
      await decisionsOf(tx, scope),
      decidedSince,
    );
    await tx.delete(findings).where(
      and(
        eq(findings.orgId, scope.orgId),
        eq(findings.workspaceId, scope.workspaceId),
        eq(findings.status, "open"),
        keep.length === 0
          ? undefined
          : notInArray(
              findings.fingerprint,
              keep.map((d) => d.fingerprint),
            ),
      ),
    );
    for (const d of keep) {
      const values = {
        kind: d.kind,
        level: d.level,
        subject: d.subject,
        windowStart: d.windowStart,
        windowEnd: d.windowEnd,
        estimatedSavingMicros: d.savingMicros,
        currency: d.currency,
        savingBasis: d.basis,
        confidence: d.confidence,
        why: d.why,
        fix: d.fix,
        citedRuns: d.citedRuns,
        citedFrames: d.evidence,
        detectedAt: passStartedAt,
      };
      await tx
        .insert(findings)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          fingerprint: d.fingerprint,
          ...values,
        })
        .onConflictDoUpdate({
          target: [findings.workspaceId, findings.fingerprint],
          targetWhere: sql`${findings.status} = 'open'`,
          set: values,
        });
    }
    return keep.length;
  });
}

const productionDeps: FindingsPassDeps = {
  now: () => new Date(),
  readRuns,
  readRootSessions,
  readToolCalls: readTachoToolCallObservations,
  readDecisions,
  write: writeFindings,
};

/**
 * One findings pass over a workspace's trailing window: read the run rows and
 * the tool calls, detect, and replace the open findings. Throws when a store
 * is degraded: the job retries rather than writing findings from missing
 * frames.
 */
export async function runFindingsPass(
  scope: FindingsScope,
  deps: FindingsPassDeps = productionDeps,
): Promise<{ findings: number }> {
  const end = deps.now();
  const start = new Date(end.getTime() - FINDINGS_WINDOW_DAYS * DAY_MS);
  const [runs, runIdBySession, rows, decidedSince] = await Promise.all([
    deps.readRuns(scope, { start, end }),
    deps.readRootSessions(scope, start),
    deps.readToolCalls({
      ...scope,
      from: start,
      to: end,
      limit: TOOL_CALL_READ_MAX,
    }),
    deps.readDecisions(scope),
  ]);
  const drafts = detectFindings({
    window: { start, end },
    toolWindowStart: toolWindowStart(start, rows, TOOL_CALL_READ_MAX),
    runs,
    toolCalls: toObservations(rows, runIdBySession),
    decidedSince,
  });
  return { findings: await deps.write(scope, end, decidedSince, drafts) };
}

/**
 * What the nightly pass visits: the workspaces with a run row in the trailing
 * findings window, and the workspaces that still hold an open finding. A
 * workspace whose runs stopped gets a pass with no runs, which deletes its
 * open findings, so they age out with their runs.
 */
export async function listWorkspacesForFindings(
  now: Date,
): Promise<FindingsScope[]> {
  const start = new Date(now.getTime() - FINDINGS_WINDOW_DAYS * DAY_MS);
  return withSystemDb((tx) =>
    tx
      .select({ orgId: totals.orgId, workspaceId: totals.workspaceId })
      .from(totals)
      .where(gte(totals.startedAt, start))
      .union(
        tx
          .select({ orgId: findings.orgId, workspaceId: findings.workspaceId })
          .from(findings)
          .where(eq(findings.status, "open")),
      ),
  );
}
