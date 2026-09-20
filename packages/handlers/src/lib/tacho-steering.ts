/**
 * The workspace's steering, compiled into the text the policy bundle carries
 * as `context.system` (ADR-091).
 *
 * A context record merged through a Context PR is published with a `force`.
 * The ones marked `must` or `should` are what the workspace told its agents
 * to do; this turns them into one block of plain text. The collector already
 * hands `context.system` to the agent at session start (Claude Code's
 * `SessionStart` `additionalContext`), so a record reaches a run the moment
 * the host next fetches its bundle. `may` and `info` records stay out: they
 * inform, and the one channel that reaches every session is kept for what
 * the workspace requires.
 *
 * What a record says is read from the version it pins, not from the record
 * row (#3312). The row carries a copy of the classification for listing, but
 * the copy is what the last write left there; the version is what the body
 * says. A version the legacy `publish_context_record` path wrote has no
 * classification of its own, and for that one the row's copy is the answer.
 *
 * The compiled text is cached per workspace, keyed on the workspace's
 * steering version (#3311). Every control poll and every event ingest
 * carries the bundle etag, and the etag is a digest of the bundle's content,
 * so without a cache every one of those responses loaded and sorted every
 * steering record in the workspace. The key carries the promotions ledger
 * length, the count of active steering records, and a digest of their pins
 * and record classifications. Direct publication changes a pin without
 * appending a promotion. Legacy versions use the record classification, so
 * those fields also participate in the digest. Soft deletion changes the
 * active set. None of these writes needs an in-process cache notification.
 *
 * The four version columns arrive in migration `20260918160000`, and
 * production applies migrations by hand while `deploy-node` ships on merge
 * without waiting. So every read here asks `information_schema` first and
 * names the version columns only once they exist; until then it compiles from
 * the record row alone, which is what this module did before #3312 and is the
 * right answer for a database on which no version can yet carry a
 * classification. The probe's answer is part of the cache key, so the text
 * compiled during the window is dropped the moment the columns land rather
 * than outliving it.
 *
 * No version counter travels in the bundle. The bundle etag is a digest of
 * the bundle's content, so a merge that adds, retires or supersedes a record
 * changes the text, the etag, and the next poll fetches the new bundle.
 */
import {
  ambientPlaneKey,
  CONTEXT_VERSION_CLASSIFICATION_COLUMN,
  hasColumn,
  type ProbeTx,
  schema,
} from "@oxagen/database";
import { and, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

/**
 * The host's limit on `context.system` (`policyBundleSchema` in
 * `@oxagen/tacho` `wire.ts`). The host parses the bundle `.strict()`, so a
 * longer string would make it reject the whole bundle and keep its old
 * mandate. The compiler stays under it by leaving records out.
 */
export const CONTEXT_SYSTEM_MAX_CHARS = 16_384;

/**
 * How many workspaces the compiled-text cache holds before it drops the
 * oldest entry. One entry is one short string, so the cap is about bounding
 * the map across tenants, not about memory per entry.
 */
export const STEERING_CACHE_MAX_ENTRIES = 1_000;

/** The forces that steer, in the order they are printed. */
const STEERING_FORCES = ["must", "should"] as const;
type SteeringForce = (typeof STEERING_FORCES)[number];

export interface SteeringRecord {
  slug: string;
  kind: string | null;
  force: string | null;
  constraintEffect: string | null;
  statement: string | null;
}

/**
 * One row of the steering read: the record's slug, the classification its
 * pinned version carries, and the record row's own copy for a legacy version
 * that has none.
 */
export interface SteeringRow {
  slug: string;
  // Optional, not just nullable: before migration `20260918160000` the read
  // cannot name these columns, so the row arrives without the keys at all.
  // `classificationOf` tests `!= null`, which is false for `undefined` too, so
  // such a row takes the record-row fallback.
  versionKind?: string | null;
  versionForce?: string | null;
  versionConstraintEffect?: string | null;
  versionStatement?: string | null;
  recordKind: string | null;
  recordForce: string | null;
  recordConstraintEffect: string | null;
  recordStatement: string | null;
}

/** The one row of the steering-version read. */
export interface SteeringVersionRow {
  ledger: number | string;
  steering: number | string;
  revisions: string | null;
}

/**
 * The transaction shape the read needs; kept narrow so tests can fake it.
 * Two statements: one over `context_promotions` that answers the cache key,
 * one over `context_records` joined to the pinned version that answers the
 * rows.
 */
export interface SteeringTx extends ProbeTx {
  select: (fields: Record<string, unknown>) => {
    from: (table: unknown) => {
      where: (condition: unknown) => Promise<unknown>;
      leftJoin: (
        table: unknown,
        on: unknown,
      ) => { where: (condition: unknown) => Promise<unknown> };
    };
  };
}

const HEADER =
  "This workspace's published steering records, merged by its reviewers through Oxagen. " +
  "Follow every MUST record. Follow every SHOULD record unless the task gives you a stated reason not to.";

const HEADINGS: Record<SteeringForce, string> = {
  must: "MUST",
  should: "SHOULD",
};

function describe(record: SteeringRecord): string {
  const kind =
    record.kind === "constraint" && record.constraintEffect
      ? `constraint, ${record.constraintEffect}`
      : (record.kind ?? "record");
  return `- ${record.statement} (${kind}; ${record.slug})`;
}

function omittedLine(count: number): string {
  return count === 1
    ? "1 more record was left out because the steering text reached its size limit."
    : `${count} more records were left out because the steering text reached its size limit.`;
}

/**
 * The `context.system` text for these records, or `null` when none of them
 * steers. Deterministic in its input set, whatever order it arrives in: the
 * text is part of the bundle etag, and an etag that moved with the database's
 * row order would make every host refetch an unchanged bundle.
 */
export function compileSteering(
  records: readonly SteeringRecord[],
  maxChars: number = CONTEXT_SYSTEM_MAX_CHARS,
): string | null {
  const steering = records
    .filter(
      (r): r is SteeringRecord & { force: SteeringForce; statement: string } =>
        (STEERING_FORCES as readonly string[]).includes(r.force ?? "") &&
        typeof r.statement === "string" &&
        r.statement.trim() !== "",
    )
    .sort((a, b) => {
      const byForce =
        STEERING_FORCES.indexOf(a.force) - STEERING_FORCES.indexOf(b.force);
      if (byForce !== 0) return byForce;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  if (steering.length === 0) return null;

  const lines = [HEADER];
  let current: SteeringForce | null = null;
  for (let i = 0; i < steering.length; i++) {
    const record = steering[i]!;
    const next: string[] = [];
    if (record.force !== current) next.push("", HEADINGS[record.force]);
    next.push(describe(record));
    const left = steering.length - i - 1;
    // Room for this record, and for the note naming what follows it if the
    // next one does not fit either.
    const reserve = left > 0 ? omittedLine(left).length + 2 : 0;
    const candidate = [...lines, ...next].join("\n");
    if (candidate.length + reserve > maxChars) {
      const omitted = steering.length - i;
      return [...lines, "", omittedLine(omitted)].join("\n");
    }
    lines.push(...next);
    current = record.force;
  }
  return lines.join("\n");
}

/**
 * What a row says: its pinned version's classification, or the record row's
 * copy when the version carries none. A merge writes all four together, so
 * `kind` alone tells a classified version from a legacy one, and the four are
 * taken as a set: a rule version's NULL `constraintEffect` must not fall
 * through to a constraint effect the row kept from an earlier version.
 */
export function classificationOf(row: SteeringRow): SteeringRecord {
  return row.versionKind != null
    ? {
        slug: row.slug,
        kind: row.versionKind,
        force: row.versionForce ?? null,
        constraintEffect: row.versionConstraintEffect ?? null,
        statement: row.versionStatement ?? null,
      }
    : {
        slug: row.slug,
        kind: row.recordKind,
        force: row.recordForce,
        constraintEffect: row.recordConstraintEffect,
        statement: row.recordStatement,
      };
}

interface CachedSteering {
  key: string;
  text: string | null;
}

const cache = new Map<string, CachedSteering>();

/** Empties the compiled-text cache. For tests, which share one process. */
export function clearSteeringCacheForTests(): void {
  cache.clear();
}

function remember(workspaceKey: string, entry: CachedSteering): void {
  // Re-inserting moves the entry to the end, so the oldest entry is always
  // the map's first key.
  cache.delete(workspaceKey);
  cache.set(workspaceKey, entry);
  while (cache.size > STEERING_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** The predicates a record row must meet to be read at all. */
function activePinnedIn(orgId: string, workspaceId: string) {
  return and(
    eq(schema.contextRecords.orgId, orgId),
    eq(schema.contextRecords.workspaceId, workspaceId),
    eq(schema.contextRecords.status, "active"),
    isNull(schema.contextRecords.deletedAt),
    isNotNull(schema.contextRecords.activeVersionId),
  );
}

/** The pinned version, joined to its record. */
const pinnedVersion = eq(
  schema.contextRecordVersions.id,
  schema.contextRecords.activeVersionId,
);

/**
 * The force a row steers with: its pinned version's, or the row's own.
 *
 * Before migration `20260918160000` there is no version force to coalesce
 * with, and naming the column would raise 42703.
 */
const effectiveForceWhen = (ready: boolean) =>
  ready
    ? sql`coalesce(${schema.contextRecordVersions.force}, ${schema.contextRecords.force})`
    : sql`${schema.contextRecords.force}`;

/**
 * Whether this database has the version classification columns yet.
 *
 * Probed on `tx` itself and filed under the plane that scope resolves to: a
 * dedicated plane is migrated separately from the shared one, and an answer
 * borrowed across the two would name a column on a database that still lacks
 * it.
 */
async function versionClassificationReady(
  tx: SteeringTx,
  planeKey: string,
): Promise<boolean> {
  return hasColumn(tx, CONTEXT_VERSION_CLASSIFICATION_COLUMN, planeKey);
}

/**
 * The workspace's steering version: the promotions ledger length, and the
 * number and revision digest of pinned, non-deleted steering records.
 *
 * Every column in the scalar subquery sits inside a nested `SQL` (`eq`,
 * `and`, `effectiveForce`) on purpose: drizzle strips the table name from a
 * column placed directly in a selected `sql` field of a single-table select,
 * and a bare `"id"` is ambiguous across the join.
 */
async function readSteeringVersion(
  tx: SteeringTx,
  orgId: string,
  workspaceId: string,
  ready: boolean,
): Promise<string> {
  const force = effectiveForceWhen(ready);
  const join = ready
    ? sql`left join ${schema.contextRecordVersions} on ${pinnedVersion}`
    : sql``;
  // Nest every column reference so Drizzle keeps its table qualifier in the
  // scalar subquery. Pins name immutable versions. The record fields cover
  // legacy versions whose classification falls back to the record row.
  const identity = sql`jsonb_build_array(${schema.contextRecords.id}, ${schema.contextRecords.activeVersionId}, ${schema.contextRecords.slug}, ${schema.contextRecords.kind}, ${schema.contextRecords.force}, ${schema.contextRecords.constraintEffect}, ${schema.contextRecords.statement})`;
  const order = sql`${schema.contextRecords.id}`;
  const rows = (await tx
    .select({
      ledger: count(),
      steering: sql`(select count(*) from ${schema.contextRecords} ${join} where ${activePinnedIn(orgId, workspaceId)} and ${force} in ('must', 'should'))`,
      revisions: sql`(select md5(string_agg(md5(${identity}::text), '' order by ${order})) from ${schema.contextRecords} ${join} where ${activePinnedIn(orgId, workspaceId)} and ${force} in ('must', 'should'))`,
    })
    .from(schema.contextPromotions)
    .where(
      and(
        eq(schema.contextPromotions.orgId, orgId),
        eq(schema.contextPromotions.workspaceId, workspaceId),
      ),
    )) as SteeringVersionRow[];
  const row = rows[0];
  return `${Number(row?.ledger ?? 0)}:${Number(row?.steering ?? 0)}:${row?.revisions ?? ""}`;
}

/** The rows that steer, each with its pinned version's classification. */
async function readSteeringRows(
  tx: SteeringTx,
  orgId: string,
  workspaceId: string,
  ready: boolean,
): Promise<SteeringRow[]> {
  const recordFields = {
    slug: schema.contextRecords.slug,
    recordKind: schema.contextRecords.kind,
    recordForce: schema.contextRecords.force,
    recordConstraintEffect: schema.contextRecords.constraintEffect,
    recordStatement: schema.contextRecords.statement,
  };
  const where = and(
    activePinnedIn(orgId, workspaceId),
    inArray(effectiveForceWhen(ready), [...STEERING_FORCES]),
  );
  // Before the migration the version columns cannot be named at all, so the
  // read is the record-row one and `classificationOf` takes its fallback for
  // every row -- the same answer, because no version can carry a
  // classification on a database that has nowhere to put one.
  if (!ready) {
    return (await tx
      .select(recordFields)
      .from(schema.contextRecords)
      .where(where)) as SteeringRow[];
  }
  return (await tx
    .select({
      ...recordFields,
      versionKind: schema.contextRecordVersions.kind,
      versionForce: schema.contextRecordVersions.force,
      versionConstraintEffect: schema.contextRecordVersions.constraintEffect,
      versionStatement: schema.contextRecordVersions.statement,
    })
    .from(schema.contextRecords)
    .leftJoin(schema.contextRecordVersions, pinnedVersion)
    .where(where)) as SteeringRow[];
}

/**
 * The workspace's active steering records, compiled for the bundle. One
 * aggregate statement on every call; records are read and compiled only when
 * the workspace's steering version has moved since the last call.
 */
export async function readWorkspaceSteering(
  tx: SteeringTx,
  orgId: string,
  workspaceId: string,
): Promise<string | null> {
  // The plane is part of the cache namespace, not just of the probe. A
  // workspace's identity does not name the database it lives on, and
  // `set_data_plane` moves an organisation between planes: two planes whose
  // migration state, ledger length and steering-record count all agree produce
  // the same key, so without this the first read on the new plane would answer
  // from text compiled against the old one and keep answering until a
  // promotion moved the count.
  const planeKey = await ambientPlaneKey();
  const workspaceKey = `${planeKey}\u0000${orgId}:${workspaceId}`;
  const ready = await versionClassificationReady(tx, planeKey);
  // The probe's answer is part of the key: the migration landing does not move
  // the ledger or the record count, so without it the text compiled from the
  // record row alone would be served on past the window.
  const key = `${ready ? "v" : "r"}:${await readSteeringVersion(tx, orgId, workspaceId, ready)}`;
  const hit = cache.get(workspaceKey);
  if (hit && hit.key === key) return hit.text;
  const rows = await readSteeringRows(tx, orgId, workspaceId, ready);
  const text = compileSteering(rows.map(classificationOf));
  remember(workspaceKey, { key, text });
  return text;
}
