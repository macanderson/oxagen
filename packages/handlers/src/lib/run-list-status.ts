// Whether a ledger run's recording was compacted (#3835, ADR-193).
//
// Compacted is a fact beside a run's status, never a status of its own. The
// lifecycle word stays `live`, `sealed` or `halted`, because about thirty
// readers treat `live` as "open" and nothing else. A compacted run reads
// `sealed` with `compacted: true`, and a paused one reads `live` with
// `ingressPaused: true`.
//
// Only the evidence ledger compacts: `evidence.frame-compaction` moves a
// sealed attempt's hot frames into its archive segment and deletes them from
// the event log (ADR-058). An archive reference alone is not the signal,
// because every graded seal carries one. The attempt is compacted when its
// seal has an archive reference and no V2 frame of the attempt is left in
// the log, the same test `ledgerCompactedRollupQuery` counts frames by.
//
// A wrapped session has no such record. Its store never compacts a
// recording, and `tacho.sessions.num_compactions` counts the harness's
// context compactions, which is another thing. So a wrapped row carries no
// `compacted` field at all.
import { schema } from "@oxagen/database";
import type { RunItem } from "@oxagen/oxagen/contracts/run.list";
import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  getTableConfig,
  type PgTable,
} from "drizzle-orm/pg-core";

const events = schema.agentRunEvents;
const seals = schema.agentRunAttemptSeals;

/**
 * True when the seal row's attempt was compacted. A column for a seal read,
 * so the latest seal of each run answers for the run.
 *
 * `event_record_version = 2` changes no answer (only a V2 row has an attempt
 * id), and it lets the partial `(attempt_id, attempt_seq)` index answer the
 * probe instead of a scan of the event log.
 */
export function compactedProbe(): SQL<boolean> {
  const seal = (column: AnyPgColumn) => qualified(seals, column);
  const event = (column: AnyPgColumn) => qualified(events, column);
  return sql<boolean>`(${seal(seals.archiveSegmentRef)} is not null and not exists (select 1 from ${events} where ${event(events.attemptId)} = ${seal(seals.attemptId)} and ${event(events.eventRecordVersion)} = 2))`;
}

/**
 * A column spelled with its schema and table. Drizzle writes a column bare
 * in the select list of a one-table query, and a bare `attempt_id` inside
 * the subquery would name the event's own column: `attempt_id = attempt_id`
 * holds for every frame, and no seal would ever read compacted.
 */
function qualified(table: PgTable, column: AnyPgColumn): SQL {
  const config = getTableConfig(table);
  return sql`${sql.identifier(config.schema ?? "public")}.${sql.identifier(config.name)}.${sql.identifier(column.name)}`;
}

/**
 * The row's `compacted` field. An open run has sealed nothing, so it has not
 * been compacted. An ended run answers what its latest seal says, and false
 * when it has no seal. A seal read that did not select the probe leaves the
 * field out.
 */
export function compactedField(
  status: RunItem["status"],
  seal: { compacted?: boolean | null } | null,
): Pick<RunItem, "compacted"> {
  if (status === "live") return { compacted: false };
  if (seal === null) return { compacted: false };
  if (seal.compacted === undefined) return {};
  return { compacted: seal.compacted === true };
}
