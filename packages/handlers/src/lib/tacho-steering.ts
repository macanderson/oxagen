/**
 * The workspace's steering, assembled into the text the policy bundle carries
 * as `context.system` and the manifest it carries as `context.manifest`
 * (ADR-091, ADR-093, ADR-144).
 *
 * A context record merged through a Context PR is published with a `force`.
 * Every active record is a candidate; `@oxagen/steering-assembler` ranks the
 * candidates by tier and then by recency, fits the `must` and `should` ones
 * to the budget, and says in the manifest what happened to each: included,
 * or cut for its tier, for the budget, or because a newer version of its
 * lineage won. This module is the assembler's only caller. It owns the read
 * of the record rows, the adapter from a row to a candidate, and the cache.
 * The collector hands `context.system` to the agent at session start
 * (Claude Code's `SessionStart` `additionalContext`) and seals the manifest
 * into the run's chain as a `steering.manifest` frame, so a record reaches a
 * run the moment the host next fetches its bundle, and the run record says
 * whether it did.
 *
 * What a record says is read from the version it pins, not from the record
 * row (#3312). The row carries a copy of the classification for listing, but
 * the copy is what the last write left there; the version is what the body
 * says. A version the legacy `publish_context_record` path wrote has no
 * classification of its own, and for that one the row's copy is the answer.
 * When a record took effect is the row's `activated_at`, which both publish
 * paths write when they pin a version.
 *
 * The assembly is cached per workspace, keyed on the workspace's steering
 * version (#3311). Every control poll and every event ingest carries the
 * bundle etag, and the etag is a digest of the bundle's content, so without
 * a cache every one of those responses loaded and ranked every steering
 * record in the workspace. The key carries the promotions ledger length, the
 * count of active steering records, and a digest of their pins, activation
 * instants and record classifications. Direct publication changes a pin
 * without appending a promotion. Legacy versions use the record
 * classification, so those fields also participate in the digest. Soft
 * deletion changes the active set. None of these writes needs an in-process
 * cache notification.
 *
 * The four version columns arrive in migration `20260918160000`, and
 * production applies migrations by hand while `deploy-node` ships on merge
 * without waiting. So every read here asks `information_schema` first and
 * names the version columns only once they exist; until then it assembles
 * from the record row alone, which is what this module did before #3312 and
 * is the right answer for a database on which no version can yet carry a
 * classification. The probe's answer is part of the cache key, so the text
 * assembled during the window is dropped the moment the columns land rather
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
import { and, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  assembleSteering,
  type SteeringCandidate,
  type SteeringForce,
  type SteeringManifest,
} from "@oxagen/steering-assembler";

/**
 * The host's limit on `context.system` (`policyBundleSchema` in
 * `@oxagen/tacho` `wire.ts`). The host parses the bundle `.strict()`, so a
 * longer string would make it reject the whole bundle and keep its old
 * mandate. The assembler stays under it by leaving records out.
 */
export const CONTEXT_SYSTEM_MAX_CHARS = 16_384;

/**
 * The assembler's budget for `context.system`, in Context Graph Protocol
 * budget tokens (`ceil(utf8_bytes / 4)`). A string never has more characters
 * than bytes, so a text under this many tokens is under the host's character
 * limit.
 */
export const CONTEXT_SYSTEM_BUDGET_TOKENS = CONTEXT_SYSTEM_MAX_CHARS / 4;

/**
 * How many workspaces the compiled-text cache holds before it drops the
 * oldest entry. One entry is one short string, so the cap is about bounding
 * the map across tenants, not about memory per entry.
 */
export const STEERING_CACHE_MAX_ENTRIES = 1_000;

/** The forces a record can carry; anything else is not a candidate. */
const RECORD_FORCES: readonly string[] = ["must", "should", "may", "info"];

export interface SteeringRecord {
  slug: string;
  kind: string | null;
  force: string | null;
  constraintEffect: string | null;
  statement: string | null;
  /** When the pinned version took effect, or null for a row that never activated. */
  activatedAt: Date | string | null;
}

/**
 * One row of the steering read: the record's slug, the classification its
 * pinned version carries, and the record row's own copy for a legacy version
 * that has none.
 */
export interface SteeringRow {
  slug: string;
  activatedAt: Date | string | null;
  createdAt: Date | string | null;
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

/** What the bundle carries: the text, and the account of how it was assembled. */
export interface WorkspaceSteering {
  /** `context.system`, or null when nothing steers. */
  text: string | null;
  manifest: SteeringManifest;
}

function instant(value: Date | string | null): string {
  if (value == null) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * The record-registry adapter (ADR-093 §3): a record as a candidate, or
 * `null` for a row that cannot steer. A row with no force cannot be ranked
 * and a row with no statement has nothing to say; both are what the schema
 * comment on `context_records` warns the legacy publish path could leave,
 * and neither can be delivered.
 *
 * The body is the line the agent reads: the statement, then the kind (with a
 * constraint's effect) and the slug, unchanged from ADR-091 so a workspace
 * that has only records receives the text it did before the assembler.
 */
export function recordCandidate(
  record: SteeringRecord,
): SteeringCandidate | null {
  if (
    !RECORD_FORCES.includes(record.force ?? "") ||
    typeof record.statement !== "string" ||
    record.statement.trim() === ""
  )
    return null;
  const kind =
    record.kind === "constraint" && record.constraintEffect
      ? `constraint, ${record.constraintEffect}`
      : (record.kind ?? "record");
  return {
    id: record.slug,
    kind: "record",
    force: record.force as SteeringForce,
    body: `${record.statement} (${kind}; ${record.slug})`,
    recordedAt: instant(record.activatedAt),
  };
}

/**
 * The bundle's steering for these records: the `must` and `should` ones
 * ranked and fitted to the budget, every one accounted for in the manifest.
 * Deterministic in its input set, whatever order it arrives in: the text is
 * part of the bundle etag, and an etag that moved with the database's row
 * order would make every host refetch an unchanged bundle.
 */
export function assembleWorkspaceSteering(
  orgId: string,
  workspaceId: string,
  records: readonly SteeringRecord[],
  budgetTokens: number = CONTEXT_SYSTEM_BUDGET_TOKENS,
): WorkspaceSteering {
  const candidates = records
    .map(recordCandidate)
    .filter((c): c is SteeringCandidate => c !== null);
  return assembleSteering({ orgId, workspaceId, candidates }, budgetTokens);
}

/**
 * What a row says: its pinned version's classification, or the record row's
 * copy when the version carries none. A merge writes all four together, so
 * `kind` alone tells a classified version from a legacy one, and the four are
 * taken as a set: a rule version's NULL `constraintEffect` must not fall
 * through to a constraint effect the row kept from an earlier version.
 */
export function classificationOf(row: SteeringRow): SteeringRecord {
  const activatedAt = row.activatedAt ?? row.createdAt;
  return row.versionKind != null
    ? {
        slug: row.slug,
        kind: row.versionKind,
        force: row.versionForce ?? null,
        constraintEffect: row.versionConstraintEffect ?? null,
        statement: row.versionStatement ?? null,
        activatedAt,
      }
    : {
        slug: row.slug,
        kind: row.recordKind,
        force: row.recordForce,
        constraintEffect: row.recordConstraintEffect,
        statement: row.recordStatement,
        activatedAt,
      };
}

interface CachedSteering {
  key: string;
  steering: WorkspaceSteering;
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
  const identity = sql`jsonb_build_array(${schema.contextRecords.id}, ${schema.contextRecords.activeVersionId}, ${schema.contextRecords.slug}, ${schema.contextRecords.kind}, ${schema.contextRecords.force}, ${schema.contextRecords.constraintEffect}, ${schema.contextRecords.statement}, ${schema.contextRecords.activatedAt})`;
  const order = sql`${schema.contextRecords.id}`;
  const forces = sql`('must', 'should', 'may', 'info')`;
  const rows = (await tx
    .select({
      ledger: count(),
      steering: sql`(select count(*) from ${schema.contextRecords} ${join} where ${activePinnedIn(orgId, workspaceId)} and ${force} in ${forces})`,
      revisions: sql`(select md5(string_agg(md5(${identity}::text), '' order by ${order})) from ${schema.contextRecords} ${join} where ${activePinnedIn(orgId, workspaceId)} and ${force} in ${forces})`,
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

/**
 * The rows that could steer, each with its pinned version's classification.
 * Every force is read: `may` and `info` are candidates the manifest accounts
 * for, cut for their tier, so the record shows they reached no session.
 */
async function readSteeringRows(
  tx: SteeringTx,
  orgId: string,
  workspaceId: string,
  ready: boolean,
): Promise<SteeringRow[]> {
  const recordFields = {
    slug: schema.contextRecords.slug,
    activatedAt: schema.contextRecords.activatedAt,
    createdAt: schema.contextRecords.createdAt,
    recordKind: schema.contextRecords.kind,
    recordForce: schema.contextRecords.force,
    recordConstraintEffect: schema.contextRecords.constraintEffect,
    recordStatement: schema.contextRecords.statement,
  };
  const where = and(
    activePinnedIn(orgId, workspaceId),
    sql`${effectiveForceWhen(ready)} in ('must', 'should', 'may', 'info')`,
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
 * The workspace's active steering records, assembled for the bundle. One
 * aggregate statement on every call; records are read and assembled only
 * when the workspace's steering version has moved since the last call.
 */
export async function readWorkspaceSteering(
  tx: SteeringTx,
  orgId: string,
  workspaceId: string,
): Promise<WorkspaceSteering> {
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
  if (hit && hit.key === key) return hit.steering;
  const rows = await readSteeringRows(tx, orgId, workspaceId, ready);
  const steering = assembleWorkspaceSteering(
    orgId,
    workspaceId,
    rows.map(classificationOf),
  );
  remember(workspaceKey, { key, steering });
  return steering;
}
