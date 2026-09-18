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
 * steering record in the workspace. The steering version is the length of
 * the workspace's promotions ledger (ADR-061 section 8): a merge, a promote,
 * a retire, and a supersede each append one ledger row, and nothing else
 * changes a record's status, its pin, or the classification behind it. So the
 * text can only change when that count moves, and one `count(*)` decides
 * whether the records need reading again. The one write that appends no
 * ledger row is a soft delete of a record row, so the key also carries the
 * number of pinned, non-deleted records that steer, read in the same query.
 * A delete lowers it, and nothing raises it without a ledger row.
 *
 * No version counter travels in the bundle. The bundle etag is a digest of
 * the bundle's content, so a merge that adds, retires or supersedes a record
 * changes the text, the etag, and the next poll fetches the new bundle.
 */
import { schema } from "@oxagen/database";
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
  versionKind: string | null;
  versionForce: string | null;
  versionConstraintEffect: string | null;
  versionStatement: string | null;
  recordKind: string | null;
  recordForce: string | null;
  recordConstraintEffect: string | null;
  recordStatement: string | null;
}

/** The one row of the steering-version read. */
export interface SteeringVersionRow {
  ledger: number | string;
  steering: number | string;
}

/**
 * The transaction shape the read needs; kept narrow so tests can fake it.
 * Two statements: one over `context_promotions` that answers the cache key,
 * one over `context_records` joined to the pinned version that answers the
 * rows.
 */
export interface SteeringTx {
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
        force: row.versionForce,
        constraintEffect: row.versionConstraintEffect,
        statement: row.versionStatement,
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

/** The force a row steers with: its pinned version's, or the row's own. */
const effectiveForce = sql`coalesce(${schema.contextRecordVersions.force}, ${schema.contextRecords.force})`;

/**
 * The workspace's steering version: the promotions ledger length, and the
 * number of pinned, non-deleted records that steer, in one statement.
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
): Promise<string> {
  const rows = (await tx
    .select({
      ledger: count(),
      steering: sql`(select count(*) from ${schema.contextRecords} left join ${schema.contextRecordVersions} on ${pinnedVersion} where ${activePinnedIn(orgId, workspaceId)} and ${effectiveForce} in ('must', 'should'))`,
    })
    .from(schema.contextPromotions)
    .where(
      and(
        eq(schema.contextPromotions.orgId, orgId),
        eq(schema.contextPromotions.workspaceId, workspaceId),
      ),
    )) as SteeringVersionRow[];
  const row = rows[0];
  return `${Number(row?.ledger ?? 0)}:${Number(row?.steering ?? 0)}`;
}

/** The rows that steer, each with its pinned version's classification. */
async function readSteeringRows(
  tx: SteeringTx,
  orgId: string,
  workspaceId: string,
): Promise<SteeringRow[]> {
  return (await tx
    .select({
      slug: schema.contextRecords.slug,
      versionKind: schema.contextRecordVersions.kind,
      versionForce: schema.contextRecordVersions.force,
      versionConstraintEffect: schema.contextRecordVersions.constraintEffect,
      versionStatement: schema.contextRecordVersions.statement,
      recordKind: schema.contextRecords.kind,
      recordForce: schema.contextRecords.force,
      recordConstraintEffect: schema.contextRecords.constraintEffect,
      recordStatement: schema.contextRecords.statement,
    })
    .from(schema.contextRecords)
    .leftJoin(schema.contextRecordVersions, pinnedVersion)
    .where(
      and(
        activePinnedIn(orgId, workspaceId),
        inArray(effectiveForce, [...STEERING_FORCES]),
      ),
    )) as SteeringRow[];
}

/**
 * The workspace's active steering records, compiled for the bundle. One
 * count statement on every call; the records are read and compiled only when
 * the workspace's steering version has moved since the last call.
 */
export async function readWorkspaceSteering(
  tx: SteeringTx,
  orgId: string,
  workspaceId: string,
): Promise<string | null> {
  const workspaceKey = `${orgId}:${workspaceId}`;
  const key = await readSteeringVersion(tx, orgId, workspaceId);
  const hit = cache.get(workspaceKey);
  if (hit && hit.key === key) return hit.text;
  const rows = await readSteeringRows(tx, orgId, workspaceId);
  const text = compileSteering(rows.map(classificationOf));
  remember(workspaceKey, { key, text });
  return text;
}
