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

import { sql, type SQL } from "drizzle-orm";
import {
  assertDataPlaneUsable,
  getScope,
  resolveDataPlane,
} from "@oxagen/tenancy";

/**
 * The least a caller must hand over: something that can run a statement.
 *
 * Declared structurally rather than as `Pick<Tx, "execute">`, because the
 * probe needs exactly one capability — issue this statement, hand back rows —
 * and pinning Drizzle's return type would exclude every caller that holds a
 * deliberately narrowed transaction type, `tacho-host.ts`'s `TachoTx` among
 * them. A method rather than a property so the parameter stays bivariant and
 * those narrower shapes remain assignable.
 */
export interface ProbeTx {
  execute(query: SQL): unknown;
}

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

/**
 * Which physical Postgres an answer came from (ADR-042).
 *
 * The cache MUST be keyed by this and not by the column alone. One process
 * serves organisations on different planes, and a dedicated plane receives its
 * migrations separately from the shared one. Keyed by column alone, a positive
 * probe on the migrated shared plane is kept for the life of the process and
 * then handed to a dedicated plane that has not been migrated — the projection
 * is dropped and the very query this exists to protect raises 42703
 * (discussion_r4040617223).
 *
 * `shared` is a stable name for the platform singleton; a dedicated plane is
 * identified by its config digest, which is what the pool keys its connections
 * on, so two orgs on the same dedicated plane share an answer and two planes
 * never do.
 */
export async function planeKeyFor(orgId: string): Promise<string> {
  const plane = await resolveDataPlane(orgId, "postgres");
  assertDataPlaneUsable(plane);
  return plane.mode === "shared" ? "shared" : `dedicated:${plane.configDigest}`;
}

/**
 * The plane of the organisation whose scope is active, for callers already
 * inside `withTenantDb`.
 *
 * Falls back to `shared` with no scope, which is the plane `withSystemDb`
 * uses — so the answer is still filed under the database it actually came
 * from rather than under a guess.
 */
export async function ambientPlaneKey(): Promise<string> {
  // Nullish rather than `=== undefined`: `getScope()` answers `null` outside a
  // scope, and a strict identity check would have treated that as a scope and
  // read `orgId` off it.
  const scope = getScope();
  return scope == null ? "shared" : planeKeyFor(scope.orgId);
}

const keyOf = (planeKey: string, ref: ColumnRef): string =>
  `${planeKey}\u0000${ref.schema}.${ref.table}.${ref.column}`;

/** Test seam. Resets every per-process answer above. */
export function resetColumnProbesForTests(): void {
  answers.clear();
}

/**
 * Whether this database has `ref`, asked at most once per process per plane
 * while the answer is yes, and at most once per {@link NEGATIVE_PROBE_TTL_MS}
 * while it is no.
 *
 * `planeKey` names the physical database `tx` is connected to
 * ({@link planeKeyFor} / {@link ambientPlaneKey}). It is a parameter rather
 * than something read off `tx` because a transaction handle does not carry its
 * plane, and an answer filed under the wrong database is worse than no cache.
 *
 * `nowMs` is a parameter rather than a `Date.now()` read so the TTL boundary
 * is testable without fake timers reaching into this module.
 */
export async function hasColumn(
  tx: ProbeTx,
  ref: ColumnRef,
  planeKey: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const key = keyOf(planeKey, ref);
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
