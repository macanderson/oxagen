// run-enrichment.ts: the candidate predicate the run-enrichment sweep and its
// two partial indexes share (#3784, ADR-153).
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * The enrichment columns both run tables carry: `tacho.sessions` and
 * `agent.agent_runs`. A table, or the columns an index callback receives,
 * satisfies it.
 */
export interface RunEnrichmentColumns {
  updatedAt: AnyPgColumn;
  summaryObservedAt: AnyPgColumn;
  summaryObservedRevision: AnyPgColumn;
  summaryError: AnyPgColumn;
  summaryInputDigest: AnyPgColumn;
}

/**
 * A run the enrichment sweep may find due at some time.
 *
 * The sweep's due rule (`dueForEnrichment` in `@oxagen/inngest-functions`)
 * compares against the clock, so no index can hold it. This is the part of
 * the rule that does not move with the clock. A run is a candidate when it
 * was never observed, its last attempt failed, it was never enriched, it
 * changed after the last read, or the last read found bodies missing. Every
 * due run is a candidate. A run that was enriched and has not changed since
 * is not, and that is most of a workspace's history.
 *
 * `tacho_sessions_enrichment_candidate_idx` and
 * `agent_runs_enrichment_candidate_idx` are declared with this predicate, and
 * the sweep adds it to its WHERE clause. Postgres uses a partial index only
 * when it can prove the query's WHERE implies the index's, so both sides
 * build the same expression here. It carries literals and no bind parameter
 * for the same reason: a `$1` in the query does not prove `'partial:%'` in
 * the index.
 *
 * Keep a per-run spend cap (#4312) out of it. Spend changes with every job,
 * so the due rule refuses a run at its cap, and this predicate still finds
 * it.
 */
export function runEnrichmentCandidate(columns: RunEnrichmentColumns): SQL {
  return sql`(${columns.summaryObservedAt} IS NULL OR ${columns.summaryError} IS NOT NULL OR ${columns.summaryObservedRevision} IS NULL OR ${columns.updatedAt} IS DISTINCT FROM ${columns.summaryObservedRevision} OR ${columns.summaryInputDigest} LIKE 'partial:%')`;
}
