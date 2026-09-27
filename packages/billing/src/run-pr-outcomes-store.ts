/**
 * run-pr-outcomes-store.ts: the reads and writes behind `cost.run_pr_outcomes`
 * (#4491). The pure rules are in ./run-pr-outcomes.ts.
 *
 * Everything here runs on the system connection with explicit org and
 * workspace predicates, as the findings store does: the hourly refresh and
 * the delivery function run outside a request's tenant scope.
 */
import { schema, withSystemDb } from "@oxagen/database";
import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  NO_PR_KEY,
  type OutcomeDelivery,
  type OutcomeRow,
  type OutcomeRunSource,
  type OutcomeScope,
  OUTCOME_WINDOW_DAYS,
  type PrRef,
  type RevertEvidence,
  type RevertMark,
  type RunPrCiState,
  type RunPrProvider,
  type RunPrState,
  ledgerTerminalReason,
  revertEvidenceOf,
  revertPlanOf,
  tachoTerminalReason,
  withStateRead,
} from "./run-pr-outcomes";

const outcomes = schema.runPrOutcomes;
const reverts = schema.runPrReverts;
const totals = schema.runTotals;
const sessions = schema.tachoSessions;
const links = schema.tachoRunPullRequests;
const agentRuns = schema.agentRuns;
const seals = schema.agentRunAttemptSeals;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A sealed run the refresh visits. */
export interface OutcomeRun {
  runId: string;
  runSource: OutcomeRunSource;
  startedAt: Date;
  sealedAt: Date;
}

/** The sealed runs that started in the trailing outcome window. */
export async function listOutcomeRuns(
  scope: OutcomeScope,
  now: Date,
): Promise<OutcomeRun[]> {
  const start = new Date(now.getTime() - OUTCOME_WINDOW_DAYS * DAY_MS);
  // tenancy: scheduled refresh outside a tenant scope; the read is filtered by orgId and workspaceId.
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        runId: totals.runId,
        runSource: totals.runSource,
        startedAt: totals.startedAt,
        sealedAt: totals.sealedAt,
      })
      .from(totals)
      .where(
        and(
          eq(totals.orgId, scope.orgId),
          eq(totals.workspaceId, scope.workspaceId),
          gte(totals.startedAt, start),
          lt(totals.startedAt, now),
          isNotNull(totals.sealedAt),
        ),
      )
      // Newest first, so a capped pass reads the runs a finding is likeliest to cite.
      .orderBy(desc(totals.startedAt)),
  );
  return rows.flatMap((r) =>
    r.sealedAt !== null &&
    (r.runSource === "ledger" || r.runSource === "tacho")
      ? [
          {
            runId: r.runId,
            runSource: r.runSource,
            startedAt: r.startedAt,
            sealedAt: r.sealedAt,
          },
        ]
      : [],
  );
}

/** Per run public id, why the run ended, or null when nothing recorded it. */
export async function readRunTerminalReasons(
  scope: OutcomeScope,
  runs: readonly OutcomeRun[],
): Promise<Map<string, string | null>> {
  const tacho = runs.filter((r) => r.runSource === "tacho").map((r) => r.runId);
  const ledger = runs
    .filter((r) => r.runSource === "ledger")
    .map((r) => r.runId);
  const reasons = new Map<string, string | null>();
  if (tacho.length > 0) {
    // tenancy: scheduled refresh outside a tenant scope; the read is filtered by orgId and workspaceId.
    const rows = await withSystemDb((tx) =>
      tx
        .select({
          publicId: sessions.publicId,
          terminalReason: sessions.terminalReason,
          endReason: sessions.endReason,
          outcome: sessions.outcome,
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.orgId, scope.orgId),
            eq(sessions.workspaceId, scope.workspaceId),
            inArray(sessions.publicId, tacho),
          ),
        ),
    );
    for (const r of rows) reasons.set(r.publicId, tachoTerminalReason(r));
  }
  if (ledger.length > 0) {
    // tenancy: scheduled refresh outside a tenant scope; both tables are filtered by orgId and workspaceId.
    const rows = await withSystemDb((tx) =>
      tx
        .select({
          publicId: agentRuns.publicId,
          terminalStatus: seals.terminalStatus,
          reasonCode: seals.reasonCode,
        })
        .from(seals)
        .innerJoin(agentRuns, eq(agentRuns.id, seals.runId))
        .where(
          and(
            eq(agentRuns.orgId, scope.orgId),
            eq(agentRuns.workspaceId, scope.workspaceId),
            eq(seals.orgId, scope.orgId),
            eq(seals.workspaceId, scope.workspaceId),
            inArray(agentRuns.publicId, ledger),
          ),
        )
        .orderBy(desc(seals.sealedAt)),
    );
    // Newest seal first: the first row per run is the attempt that ended it.
    for (const r of rows)
      if (!reasons.has(r.publicId))
        reasons.set(r.publicId, ledgerTerminalReason(r));
  }
  return reasons;
}

/** A pull request a wrapped run's record links, with the state the forge webhooks keep. */
export interface TachoPrLink {
  runId: string;
  url: string;
  provider: RunPrProvider;
  repository: string;
  number: number;
  state: RunPrState | null;
  stateSeenAt: Date | null;
  sourceUpdatedAt: Date | null;
}

/** The pull requests the wrapped runs' records link, from `tacho.run_pull_requests`. */
export async function readTachoRunPrLinks(
  scope: OutcomeScope,
  runIds: readonly string[],
): Promise<TachoPrLink[]> {
  if (runIds.length === 0) return [];
  // tenancy: scheduled refresh outside a tenant scope; both tables are filtered by orgId and workspaceId.
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        runId: sessions.publicId,
        url: links.url,
        provider: links.provider,
        repository: links.repository,
        number: links.number,
        state: links.state,
        stateSeenAt: links.stateSeenAt,
        sourceUpdatedAt: links.sourceUpdatedAt,
      })
      .from(links)
      .innerJoin(sessions, eq(sessions.id, links.sessionId))
      .where(
        and(
          eq(links.orgId, scope.orgId),
          eq(links.workspaceId, scope.workspaceId),
          eq(sessions.orgId, scope.orgId),
          eq(sessions.workspaceId, scope.workspaceId),
          inArray(sessions.publicId, [...runIds]),
        ),
      ),
  );
  return rows.flatMap((r) =>
    (r.provider === "github" || r.provider === "gitlab") && r.number > 0
      ? [
          {
            ...r,
            provider: r.provider,
            repository: r.repository.toLowerCase(),
            state:
              r.state === "open" || r.state === "closed" || r.state === "merged"
                ? r.state
                : null,
          },
        ]
      : [],
  );
}

type OutcomeDbRow = typeof outcomes.$inferSelect;

function rowOf(r: OutcomeDbRow): OutcomeRow {
  return {
    runId: r.runId,
    runSource: r.runSource as OutcomeRunSource,
    prKey: r.prKey,
    provider: r.provider as RunPrProvider | null,
    repository: r.repository,
    number: r.number,
    url: r.url,
    prState: r.prState as RunPrState | null,
    prStateReadAt: r.prStateReadAt,
    forgeReadAttemptedAt: r.forgeReadAttemptedAt,
    closedAt: r.closedAt,
    merged: r.merged,
    mergedAt: r.mergedAt,
    mergeCommitSha: r.mergeCommitSha,
    baseRef: r.baseRef,
    headRef: r.headRef,
    headSha: r.headSha,
    headBranchExists: r.headBranchExists,
    headBranchReadAt: r.headBranchReadAt,
    ciState: r.ciState as RunPrCiState | null,
    ciReadAt: r.ciReadAt,
    reverted: r.reverted,
    revertedBy: r.revertedBy,
    revertedAt: r.revertedAt,
    revertedReadAt: r.revertedReadAt,
    terminalReason: r.terminalReason,
    terminalReasonReadAt: r.terminalReasonReadAt,
    sourceUpdatedAt: r.sourceUpdatedAt,
  };
}

/** The stored rows of the given runs. */
export async function readOutcomeRows(
  scope: OutcomeScope,
  runIds: readonly string[],
): Promise<OutcomeRow[]> {
  if (runIds.length === 0) return [];
  // tenancy: scheduled refresh outside a tenant scope; the read is filtered by orgId and workspaceId.
  const rows = await withSystemDb((tx) =>
    tx
      .select()
      .from(outcomes)
      .where(
        and(
          eq(outcomes.orgId, scope.orgId),
          eq(outcomes.workspaceId, scope.workspaceId),
          inArray(outcomes.runId, [...runIds]),
        ),
      ),
  );
  return rows.map(rowOf);
}

/** The columns a write sets; the run, its source, and the key identify the row. */
function valuesOf(row: OutcomeRow) {
  return {
    provider: row.provider,
    repository: row.repository,
    number: row.number,
    url: row.url,
    prState: row.prState,
    prStateReadAt: row.prStateReadAt,
    forgeReadAttemptedAt: row.forgeReadAttemptedAt,
    closedAt: row.closedAt,
    merged: row.merged,
    mergedAt: row.mergedAt,
    mergeCommitSha: row.mergeCommitSha,
    baseRef: row.baseRef,
    headRef: row.headRef,
    headSha: row.headSha,
    headBranchExists: row.headBranchExists,
    headBranchReadAt: row.headBranchReadAt,
    ciState: row.ciState,
    ciReadAt: row.ciReadAt,
    reverted: row.reverted,
    revertedBy: row.revertedBy,
    revertedAt: row.revertedAt,
    revertedReadAt: row.revertedReadAt,
    terminalReason: row.terminalReason,
    terminalReasonReadAt: row.terminalReasonReadAt,
    sourceUpdatedAt: row.sourceUpdatedAt,
  };
}

/**
 * Whether the row a write carries may replace the stored row. A state GitHub
 * dated wins over an undated one, and the later `updated_at` wins between two
 * dated states. Between two undated states, the later read wins. An undated
 * write never replaces a dated row, so a pass that read no GitHub time cannot
 * undo a delivery that carried one. `isStaleRead` holds the same order for a
 * read the refresh folds into a row in memory.
 */
const replacesStored = sql`(excluded.source_updated_at IS NOT NULL AND (${outcomes.sourceUpdatedAt} IS NULL OR excluded.source_updated_at >= ${outcomes.sourceUpdatedAt})) OR (excluded.source_updated_at IS NULL AND ${outcomes.sourceUpdatedAt} IS NULL AND (${outcomes.prStateReadAt} IS NULL OR excluded.pr_state_read_at >= ${outcomes.prStateReadAt}))`;

/**
 * Write rows the refresh computed, one upsert per run and pull request. The
 * write keeps two things a delivery may have written since the refresh read
 * the row: a newer state, which skips the update (`replacesStored`), and a
 * revert, which stays once marked. A run that gains a pull request row loses
 * its `none` row.
 */
export async function saveOutcomeRows(
  scope: OutcomeScope,
  rows: readonly OutcomeRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const withPr = [
    ...new Set(rows.filter((r) => r.prKey !== NO_PR_KEY).map((r) => r.runId)),
  ];
  // tenancy: scheduled refresh outside a tenant scope; every row carries the orgId and workspaceId it is filtered by.
  return withSystemDb(async (tx) => {
    let written = 0;
    for (const row of rows) {
      const values = valuesOf(row);
      const result = await tx
        .insert(outcomes)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          runId: row.runId,
          runSource: row.runSource,
          prKey: row.prKey,
          ...values,
        })
        .onConflictDoUpdate({
          target: [outcomes.runId, outcomes.prKey],
          set: {
            ...values,
            reverted: sql`${outcomes.reverted} OR excluded.reverted`,
            revertedBy: sql`CASE WHEN ${outcomes.reverted} THEN ${outcomes.revertedBy} ELSE excluded.reverted_by END`,
            revertedAt: sql`CASE WHEN ${outcomes.reverted} THEN ${outcomes.revertedAt} ELSE excluded.reverted_at END`,
            revertedReadAt: sql`CASE WHEN ${outcomes.reverted} THEN ${outcomes.revertedReadAt} ELSE excluded.reverted_read_at END`,
            updatedAt: sql`now()`,
          },
          setWhere: sql`${outcomes.orgId} = ${scope.orgId} AND ${outcomes.workspaceId} = ${scope.workspaceId} AND (${replacesStored})`,
        })
        .returning({ id: outcomes.id });
      written += result.length;
    }
    if (withPr.length > 0)
      await tx
        .delete(outcomes)
        .where(
          and(
            eq(outcomes.orgId, scope.orgId),
            eq(outcomes.workspaceId, scope.workspaceId),
            eq(outcomes.prKey, NO_PR_KEY),
            inArray(outcomes.runId, withPr),
          ),
        );
    return written;
  });
}

function revertSet(mark: RevertMark) {
  return {
    reverted: true,
    revertedBy: mark.by,
    revertedAt: mark.at,
    revertedReadAt: mark.readAt,
    updatedAt: sql`now()`,
  };
}

/** Mark the rows of the named pull requests reverted. A row already reverted keeps its first revert. */
export async function markPullRequestsReverted(
  scope: OutcomeScope,
  targets: readonly PrRef[],
  mark: RevertMark,
): Promise<number> {
  if (targets.length === 0) return 0;
  // tenancy: webhook delivery outside a tenant scope; each update is filtered by orgId and workspaceId.
  return withSystemDb(async (tx) => {
    let marked = 0;
    for (const target of targets) {
      const result = await tx
        .update(outcomes)
        .set(revertSet(mark))
        .where(
          and(
            eq(outcomes.orgId, scope.orgId),
            eq(outcomes.workspaceId, scope.workspaceId),
            eq(outcomes.provider, "github"),
            eq(outcomes.repository, target.repository.toLowerCase()),
            eq(outcomes.number, target.number),
            eq(outcomes.reverted, false),
          ),
        )
        .returning({ id: outcomes.id });
      marked += result.length;
    }
    return marked;
  });
}

/**
 * Mark reverted the rows whose merge commit a pushed commit reverts. A
 * revert counts on the branch the pull request merged into. A commit whose
 * branch the connector did not record matches any branch.
 */
export async function markMergeCommitsReverted(
  scope: OutcomeScope,
  plan: { repository: string; shas: readonly string[]; branch: string | null },
  mark: RevertMark,
): Promise<number> {
  if (plan.shas.length === 0) return 0;
  // tenancy: webhook delivery outside a tenant scope; the update is filtered by orgId and workspaceId.
  const rows = await withSystemDb((tx) =>
    tx
      .update(outcomes)
      .set(revertSet(mark))
      .where(
        and(
          eq(outcomes.orgId, scope.orgId),
          eq(outcomes.workspaceId, scope.workspaceId),
          eq(outcomes.provider, "github"),
          eq(outcomes.repository, plan.repository.toLowerCase()),
          inArray(outcomes.mergeCommitSha, [...plan.shas]),
          eq(outcomes.reverted, false),
          plan.branch === null ? undefined : eq(outcomes.baseRef, plan.branch),
        ),
      )
      .returning({ id: outcomes.id }),
  );
  return rows.length;
}

/**
 * Fold a GitHub pull request delivery into the rows of that pull request,
 * under newer-wins, and lock them while it does. A delivery for a pull
 * request no run opened finds no row and writes nothing: the hourly refresh
 * creates the rows.
 */
async function applyPullRequestState(
  scope: OutcomeScope,
  delivery: Extract<OutcomeDelivery, { kind: "pull_request" }>,
): Promise<number> {
  // tenancy: webhook delivery outside a tenant scope; the read and each update are filtered by orgId and workspaceId.
  return withSystemDb(async (tx) => {
    const found = await tx
      .select()
      .from(outcomes)
      .where(
        and(
          eq(outcomes.orgId, scope.orgId),
          eq(outcomes.workspaceId, scope.workspaceId),
          eq(outcomes.provider, "github"),
          eq(outcomes.repository, delivery.repository),
          eq(outcomes.number, delivery.number),
        ),
      )
      .for("update");
    let written = 0;
    for (const stored of found) {
      const row = rowOf(stored);
      const next = withStateRead(row, delivery);
      if (next === row) continue;
      await tx
        .update(outcomes)
        .set({ ...valuesOf(next), updatedAt: sql`now()` })
        .where(
          and(
            eq(outcomes.orgId, scope.orgId),
            eq(outcomes.workspaceId, scope.workspaceId),
            eq(outcomes.id, stored.id),
          ),
        );
      written += 1;
    }
    return written;
  });
}

/**
 * Keep reverts until the rows they revert exist. A revert already kept stays
 * as first written, so a retried delivery or a second pass writes nothing.
 */
export async function saveRevertEvidence(
  scope: OutcomeScope,
  evidence: readonly RevertEvidence[],
): Promise<number> {
  if (evidence.length === 0) return 0;
  // tenancy: delivery or scheduled refresh outside a tenant scope; every row carries the orgId and workspaceId it is filtered by.
  const rows = await withSystemDb((tx) =>
    tx
      .insert(reverts)
      .values(
        evidence.map((e) => ({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          repository: e.repository.toLowerCase(),
          number: e.number,
          mergeCommitSha: e.mergeCommitSha,
          branch: e.branch,
          revertedBy: e.mark.by,
          revertedAt: e.mark.at,
          readAt: e.mark.readAt,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: reverts.id }),
  );
  return rows.length;
}

/**
 * The workspace's reverts Oxagen saw since the given time. The refresh asks
 * for the outcome window: a revert of a run's pull request lands after the
 * run started, so every revert of a run in the window was seen inside it.
 */
export async function readRevertEvidence(
  scope: OutcomeScope,
  since: Date,
): Promise<RevertEvidence[]> {
  // tenancy: scheduled refresh outside a tenant scope; the read is filtered by orgId and workspaceId.
  const rows = await withSystemDb((tx) =>
    tx
      .select()
      .from(reverts)
      .where(
        and(
          eq(reverts.orgId, scope.orgId),
          eq(reverts.workspaceId, scope.workspaceId),
          gte(reverts.readAt, since),
        ),
      ),
  );
  return rows.map((r) => ({
    repository: r.repository,
    number: r.number,
    mergeCommitSha: r.mergeCommitSha,
    branch: r.branch,
    mark: { by: r.revertedBy, at: r.revertedAt, readAt: r.readAt },
  }));
}

/** Delete the reverts Oxagen saw before the given time, in every workspace. */
export async function pruneRevertEvidence(before: Date): Promise<number> {
  // tenancy: global scheduled job prunes rows across all orgs by age alone; it reads no row's contents.
  const rows = await withSystemDb((tx) =>
    tx
      .delete(reverts)
      .where(lt(reverts.readAt, before))
      .returning({ id: reverts.id }),
  );
  return rows.length;
}

/**
 * Apply one GitHub delivery: a pull request's new state to its rows, and the
 * reverts a merged pull request or a pushed commit records. A revert is kept
 * before any row is marked, so one whose target row the refresh has not
 * written yet still reaches it when the refresh writes it.
 */
export async function applyOutcomeDelivery(
  scope: OutcomeScope,
  delivery: OutcomeDelivery,
): Promise<{ rows: number; reverted: number }> {
  const plan = revertPlanOf(delivery);
  if (plan !== null) await saveRevertEvidence(scope, revertEvidenceOf(plan));
  const rows =
    delivery.kind === "pull_request"
      ? await applyPullRequestState(scope, delivery)
      : 0;
  if (plan === null) return { rows, reverted: 0 };
  const reverted =
    plan.kind === "pull_requests"
      ? await markPullRequestsReverted(scope, plan.targets, plan.mark)
      : await markMergeCommitsReverted(scope, plan, plan.mark);
  return { rows, reverted };
}

/** The workspaces with a sealed run in the trailing outcome window. */
export async function listWorkspacesForOutcomes(
  now: Date,
): Promise<OutcomeScope[]> {
  const start = new Date(now.getTime() - OUTCOME_WINDOW_DAYS * DAY_MS);
  // tenancy: global scheduled job lists workspaces across all orgs; each later read is filtered by orgId and workspaceId.
  return withSystemDb((tx) =>
    tx
      .selectDistinct({ orgId: totals.orgId, workspaceId: totals.workspaceId })
      .from(totals)
      .where(and(gte(totals.startedAt, start), isNotNull(totals.sealedAt))),
  );
}
