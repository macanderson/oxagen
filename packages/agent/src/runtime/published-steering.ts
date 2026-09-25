/**
 * The workspace's published steering records, read from the registry and
 * adapted into candidates for the assembler (ADR-093 §3).
 *
 * Two surfaces read published steering, and both read it here, so a record
 * reaches a wrapped agent and the in-app assistant in the same words:
 *
 *  - the policy bundle a wrapped agent's host fetches
 *    (`readWorkspaceSteering` in `packages/handlers/src/lib/tacho-steering.ts`,
 *    which caches the assembled bundle text per workspace);
 *  - the in-app assistant's turn (`assistant-steering.ts`).
 *
 * This module sits in `@oxagen/agent` because `@oxagen/handlers` depends on
 * it and not the other way round, so it is the lowest package both callers
 * can import. It owns the record read and the record adapter, and nothing
 * else. Ranking and budget belong to `@oxagen/steering-assembler`.
 *
 * What a record says is read from the version it pins, not from the record
 * row (#3312). The row carries a copy of the classification for listing, but
 * the copy is what the last write left there; the version is what the body
 * says. A version the legacy `publish_context_record` path wrote has no
 * classification of its own, and for that one the row's copy is the answer.
 * When a record took effect is the row's `activated_at`, which both publish
 * paths write when they pin a version.
 *
 * The four version columns arrive in migration `20260918160000`. Every read
 * here asks `information_schema` first and names the version columns only
 * once they exist; until then it reads the record row alone, which is the
 * right answer for a database on which no version can yet carry a
 * classification.
 */
import {
  ambientPlaneKey,
  CONTEXT_VERSION_CLASSIFICATION_COLUMN,
  hasColumn,
  type ProbeTx,
  schema,
} from "@oxagen/database";
import type {
  SteeringCandidate,
  SteeringForce,
} from "@oxagen/steering-assembler";
import { and, count, eq, isNotNull, isNull, sql } from "drizzle-orm";

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
export async function versionClassificationReady(
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
export async function readSteeringVersion(
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
 * for, cut for their tier, so the record shows they reached no agent.
 */
export async function readSteeringRows(
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
 * Every active, pinned record in the workspace as an assembler candidate, in
 * the order the store returned them. The assembler's ranking does not depend
 * on that order. A row that cannot steer (no force, no statement) is left
 * out, as `recordCandidate` explains.
 *
 * Uncached: one probe and one select per call. The bundle keeps its own
 * cache keyed on the steering version (`readWorkspaceSteering`); a turn of
 * the in-app assistant reads once and is far rarer than a host's poll.
 */
export async function readPublishedSteeringCandidates(
  tx: SteeringTx,
  orgId: string,
  workspaceId: string,
): Promise<SteeringCandidate[]> {
  const ready = await versionClassificationReady(tx, await ambientPlaneKey());
  const rows = await readSteeringRows(tx, orgId, workspaceId, ready);
  return rows
    .map((row) => recordCandidate(classificationOf(row)))
    .filter((c): c is SteeringCandidate => c !== null);
}
