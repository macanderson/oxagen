// idle-attempts.ts — the scan behind the control plane's close of a ledger
// attempt whose producer stopped reporting (#3988, ADR-173).
//
// A ledger attempt seals through `sealAttempt`, which its producer calls: the
// in-app assistant when its turn settles, a preflight refusal, or
// `approval-resume`. When the process dies mid-turn (a deploy, an OOM, a
// crash), nothing calls it. The run reads as live on Fleet for good, and the
// nightly cost sweep never reaches it, because a ledger run is rolled up from
// its seal.
//
// This module finds those attempts. The close itself is `sealAttempt` with
// `terminalStatus: "abandoned"` and `expectedAttemptSeq` set to the head read
// here, so a producer that appends between the scan and the close keeps its
// attempt open. The scheduled job that drives both lives in
// `@oxagen/inngest-functions` (`run.ledger-idle-close`).
import { withSystemDb, type Tx } from "@oxagen/database";
import { sql, type SQL } from "drizzle-orm";

/**
 * How long an open attempt may go without an event before the control plane
 * closes it: twelve hours, the same silence ADR-159 allows a wrapped session.
 * An assistant turn records a frame at every model and tool call and parks no
 * longer than an approval's five minutes, so twelve silent hours means its
 * process is gone. A producer on `/v1/run-ingest` refreshes a fifteen-minute
 * credential with every batch, so it too has stopped long before this.
 */
export const LEDGER_IDLE_CLOSE_AFTER_MS = 12 * 60 * 60 * 1000;

/** The reason code the idle close records on the seal. */
export const LEDGER_IDLE_CLOSE_REASON = "idle_timeout";

/** An open attempt the scan found idle, with the head its close commits to. */
export interface IdleLedgerAttempt {
  runId: string;
  runPublicId: string;
  orgId: string;
  workspaceId: string;
  attemptId: string;
  attemptPublicId: string;
  /** The attempt's last `attempt_seq`, 0 when it has no event. */
  lastAttemptSeq: number;
  /**
   * The later of the last event's recorded time (the claim time when it has
   * none) and the run row's last write, which a resume stamps.
   */
  lastActivityAt: Date;
}

/** The instant before which an attempt's last activity makes it idle. */
export function ledgerIdleCutoff(now: Date): Date {
  return new Date(now.getTime() - LEDGER_IDLE_CLOSE_AFTER_MS);
}

/**
 * The open attempts of evidence-grade (V2) runs whose last activity is older
 * than `cutoff`. Oldest first, at most `limit`, leaving out the attempts
 * named in `exclude`.
 *
 * An attempt is open while its run names it as `active_attempt_id` and no
 * seal row exists for it. The run filter matches the partial index
 * `agent_runs_v2_claim_idx`, and the last event is read through the
 * `(attempt_id, attempt_seq)` unique index, highest first. Appends serialize
 * on the run lock, so the highest sequence is also the latest recorded.
 *
 * Two rules keep the close off a run an operator is holding (ADR-173):
 *
 * - A run whose evidence ingress is paused is never listed. The pause refuses
 *   every append, so the silence is the operator's doing, not a sign that
 *   the producer is gone.
 * - Silence counts from the later of the last event (or the claim) and the
 *   run row's `updated_at`. `setRunIngressPaused` stamps `updated_at`, so a
 *   resume starts a fresh twelve hours instead of closing the run at the next
 *   pass. Every append stamps it too. Any other write to the row, such as a
 *   cancel or a requested summary, can only make the close later.
 *
 * `exclude` lets one pass skip the attempts it has already tried, so an
 * attempt whose close fails every time cannot hold the head of every page.
 */
export function buildListIdleAttemptsSql(
  cutoff: Date,
  limit: number,
  exclude: readonly string[] = [],
): SQL {
  const lastActivity = sql`greatest(coalesce(e.created_at, a.claimed_at), r.updated_at)`;
  const notTried =
    exclude.length === 0
      ? sql``
      : sql`AND a.id <> ALL(${`{${exclude.join(",")}}`}::uuid[])`;
  return sql`
    SELECT
      r.id            AS run_id,
      r.public_id     AS run_public_id,
      r.org_id,
      r.workspace_id,
      a.id            AS attempt_id,
      a.public_id     AS attempt_public_id,
      coalesce(e.attempt_seq, 0) AS last_attempt_seq,
      ${lastActivity} AS last_activity_at
    FROM agent.agent_runs r
    JOIN agent.agent_run_attempts a ON a.id = r.active_attempt_id
    LEFT JOIN LATERAL (
      SELECT ev.attempt_seq, ev.created_at
      FROM agent.agent_run_events ev
      WHERE ev.attempt_id = a.id AND ev.event_record_version = 2
      ORDER BY ev.attempt_seq DESC
      LIMIT 1
    ) e ON true
    WHERE r.spec_version = 2
      AND r.status IN ('pending', 'running')
      AND NOT r.ingress_paused
      AND NOT EXISTS (
        SELECT 1 FROM agent.agent_run_attempt_seals s WHERE s.attempt_id = a.id
      )
      AND ${lastActivity} < ${cutoff.toISOString()}::timestamptz
      ${notTried}
    ORDER BY ${lastActivity} ASC
    LIMIT ${limit}
  `;
}

/** A row as `buildListIdleAttemptsSql` returns it. */
export interface IdleLedgerAttemptRow {
  run_id: string;
  run_public_id: string;
  org_id: string;
  workspace_id: string;
  attempt_id: string;
  attempt_public_id: string;
  last_attempt_seq: number | string;
  last_activity_at: Date | string;
}

export function mapIdleLedgerAttemptRow(
  row: IdleLedgerAttemptRow,
): IdleLedgerAttempt {
  return {
    runId: row.run_id,
    runPublicId: row.run_public_id,
    orgId: row.org_id,
    workspaceId: row.workspace_id,
    attemptId: row.attempt_id,
    attemptPublicId: row.attempt_public_id,
    lastAttemptSeq: Number(row.last_attempt_seq),
    lastActivityAt: new Date(row.last_activity_at),
  };
}

/**
 * Every organization's idle attempts. The scheduled close runs outside a
 * tenant scope, so this reads through `withSystemDb`; each row carries its own
 * organization and workspace, and the close seals it in that tenant's scope.
 */
export async function listIdleLedgerAttempts(args: {
  cutoff: Date;
  limit: number;
  /** Attempt ids to leave out, such as the ones this pass already tried. */
  exclude?: readonly string[];
}): Promise<IdleLedgerAttempt[]> {
  // tenancy: a scheduled cross-tenant scan by design, like the wrapped-session
  // idle close. It reads ids and timestamps only; each seal is then scoped to
  // the row's own orgId and workspaceId.
  const rows = await withSystemDb(
    async (tx: Tx) =>
      (await tx.execute(
        buildListIdleAttemptsSql(args.cutoff, args.limit, args.exclude),
      )) as unknown as IdleLedgerAttemptRow[],
  );
  return rows.map(mapIdleLedgerAttemptRow);
}
