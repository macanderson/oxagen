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

import { AsyncLocalStorage } from "node:async_hooks";
import { sql, type SQL } from "drizzle-orm";

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
 * never do. `tenant.ts` builds the key at the moment it resolves the plane —
 * there is deliberately no exported "resolve the plane key for this org"
 * helper, because calling one is how an answer ends up filed under a database
 * the statement did not run on (#3223).
 */
/**
 * The plane the transaction currently open was actually opened against.
 *
 * ## Why this is a binding and not a second lookup
 *
 * This used to re-resolve: read the ambient tenancy scope, call
 * `resolveDataPlane` again, and file the probe's answer under whatever came
 * back. Two resolutions of the same question can disagree. `set_data_plane`
 * repointing the organisation between them left `tx` on the OLD plane while
 * the answer was cached under the NEW plane's key — and a positive answer is
 * kept for the life of the process, so the new database was then told
 * indefinitely that it has a column it does not have, the compatibility
 * projection was dropped, and the read raised the very 42703 the probe exists
 * to prevent (#3223, discussion_r4040685685).
 *
 * The seams that open a transaction have already resolved the plane — that
 * resolution is what selected the connection — so they publish it here and
 * this reads it back. The invariant becomes structural rather than an
 * agreement between two callers: **an answer is filed under the database it
 * was asked of, because the thing that chose the database is the thing that
 * named it.**
 *
 * ## No binding
 *
 * `shared`, and nothing is re-resolved. A caller with no binding is not inside
 * a plane-resolving seam, which means it holds the process singleton — the
 * shared plane — because that is the only database reachable without one.
 * Guessing by resolving a second time is exactly the defect above.
 */
export async function ambientPlaneKey(): Promise<string> {
  return boundPlaneKey.getStore() ?? "shared";
}

const boundPlaneKey = new AsyncLocalStorage<string>();

/**
 * Publish the plane a transaction is being opened on, for the probes that run
 * inside it. Called by the seams in `tenant.ts`, which are the only places
 * that resolve a plane and open a connection to it.
 */
export function runOnPlane<T>(
  planeKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  return boundPlaneKey.run(planeKey, fn);
}

/** The plane key a caller would file an answer under right now. Tests only. */
export function boundPlaneKeyForTests(): string | undefined {
  return boundPlaneKey.getStore();
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
 * ({@link ambientPlaneKey}, or the key `tenant.ts` resolved). It is a
 * parameter rather
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
  return probe(tx, ref, planeKey, nowMs, true);
}

/**
 * The same question, without trusting a cached MISS.
 *
 * For a caller whose wrong answer does not heal itself. A read that projects a
 * column away for one more request compiles from the fallback and is right
 * again on the next call, so it can spend {@link NEGATIVE_PROBE_TTL_MS} being
 * conservative. A WRITE that omits a column cannot: the row it wrote carries
 * NULL for good, the one-time migration backfill has already run, and nothing
 * afterwards fills it in (discussion_r4050451667).
 *
 * So a write path asks the database every time rather than believing a miss
 * recorded up to a minute ago. A cached POSITIVE is still trusted, here as
 * everywhere: a column that exists does not stop existing, and that is the
 * answer on every call after the migration lands. The extra round trip is
 * therefore paid only while the migration is genuinely pending, and only by
 * writes, which are rare next to the reads this protects.
 */
export async function hasColumnFresh(
  tx: ProbeTx,
  ref: ColumnRef,
  planeKey: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  return probe(tx, ref, planeKey, nowMs, false);
}

async function probe(
  tx: ProbeTx,
  ref: ColumnRef,
  planeKey: string,
  nowMs: number,
  trustCachedMiss: boolean,
): Promise<boolean> {
  const key = keyOf(planeKey, ref);
  const seen = answers.get(key);
  if (seen?.present === true) return true;
  if (
    trustCachedMiss &&
    seen !== undefined &&
    nowMs - seen.probedAtMs < NEGATIVE_PROBE_TTL_MS
  ) {
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
