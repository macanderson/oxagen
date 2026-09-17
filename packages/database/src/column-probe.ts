/**
 * column-probe.ts — "does this database have that column yet?", asked safely.
 *
 * Deployment and migration are separate manual steps in this repo
 * (`pipeline.yml`: `deploy-node` no longer waits for a migrate job; restoring
 * that ordering is #1275). Production therefore runs new code against a schema
 * that may still be one migration behind, and every unconditional reference to
 * a column added by that migration raises PostgreSQL 42703 for the whole
 * window.
 *
 * ## Why this asks first rather than trying and recovering
 *
 * The obvious shape — issue the statement, catch 42703, retry without the
 * column — cannot work. 42703 ABORTS the enclosing transaction, so catching
 * the exception does not restore it and the retry raises 25P02
 * (`current transaction is aborted`). A unit mock that rejects one query and
 * answers the next models the error but not what PostgreSQL does to the
 * transaction around it, so such a test passes while the code does not work.
 * That exact pair — a wrong fix and three tests agreeing with it — is what
 * `plan-allowance.ts` shipped and had to correct (discussion_r4034318891).
 *
 * Asking `information_schema` first has no error path to get wrong: it always
 * answers, and it answers without putting the transaction at risk.
 *
 * This module is the generalisation of that fix. `plan-allowance.ts` proved
 * the shape on one column; a second migration needing it (the two Tacho
 * gateway columns, discussion_r4040352870) is the point at which copying it a
 * third time becomes the defect.
 */

import { sql } from "drizzle-orm";
import type { Tx } from "./tenant";

/** The least a caller must hand over: something that can run a statement. */
export type ProbeTx = Pick<Tx, "execute">;

/** A column identified the way `information_schema` identifies one. */
export interface ColumnRef {
  /** PostgreSQL schema, e.g. `tacho` — not the Drizzle binding name. */
  schema: string;
  /** SQL table name, e.g. `hosts` — not the `tachoHosts` TypeScript spelling. */
  table: string;
  /** SQL column name, e.g. `gateway_last_seen_at`. */
  column: string;
}

/**
 * How long a NEGATIVE probe is trusted before asking again.
 *
 * A positive answer is kept for the life of the process, because a column that
 * exists does not stop existing. A negative one must expire: production
 * migrations are applied by hand, so an instance that started before the
 * migration has to notice it afterwards. Caching the miss forever meant one
 * such instance ignored the new column until it was recycled
 * (discussion_r4035774861).
 *
 * A minute is short enough that a hand-applied migration takes effect while
 * the operator is still watching, and long enough that the probe is not a
 * round trip per call.
 */
export const NEGATIVE_PROBE_TTL_MS = 60_000;

/** What the last probe said about one column, and when it said it. */
interface Probed {
  present: boolean;
  probedAtMs: number;
}

const answers = new Map<string, Probed>();

const keyOf = (ref: ColumnRef): string =>
  `${ref.schema}.${ref.table}.${ref.column}`;

/** Test seam. Resets every per-process answer above. */
export function resetColumnProbesForTests(): void {
  answers.clear();
}

/**
 * Whether this database has `ref`, asked at most once per process while the
 * answer is yes, and at most once per {@link NEGATIVE_PROBE_TTL_MS} while it
 * is no.
 *
 * `nowMs` is a parameter rather than a `Date.now()` read so the TTL boundary
 * is testable without fake timers reaching into this module.
 */
export async function hasColumn(
  tx: ProbeTx,
  ref: ColumnRef,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const key = keyOf(ref);
  const seen = answers.get(key);
  if (seen?.present === true) return true;
  if (seen !== undefined && nowMs - seen.probedAtMs < NEGATIVE_PROBE_TTL_MS) {
    return false;
  }
  const rows = await tx.execute(sql`
    select 1
      from information_schema.columns
     where table_schema = ${ref.schema}
       and table_name = ${ref.table}
       and column_name = ${ref.column}
     limit 1
  `);
  const present = Array.from(rows as Iterable<unknown>).length > 0;
  answers.set(key, { present, probedAtMs: nowMs });
  return present;
}
