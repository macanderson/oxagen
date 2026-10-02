// workspace-store.ts: the Postgres reads and writes behind the workspace
// memory capabilities (memory-collection spec, Memories tab, Promotion, and
// Lifecycle; ADR-245).
//
// store.ts holds what the curator and Tacho read and write. This file holds
// what a person does from the Memories tab, the CLI, or MCP: list and read
// memories, dismiss and restore them, and add records to an open memory PR.
// Each method opens the scope's tenant transaction and filters by the scope
// as well, so one missing policy still leaks no row. A method given an empty
// id list returns before any query.
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import type { RecordKind } from "@oxagen/oxagen/steering-repo/record";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, asc, count, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { MemoryHarness } from "./workspace";
import type {
  MemoryCapture,
  MemoryPrRecord,
  MemoryScope,
  MemoryState,
  MemoryUseSignal,
  RetiredReason,
} from "./types";

const inScope = <T>(scope: MemoryScope, fn: (tx: Tx) => Promise<T>) =>
  runInTenantScope(scope, () => withTenantDb(fn));

const scoped = (
  table: { orgId: PgColumn; workspaceId: PgColumn },
  scope: MemoryScope,
) =>
  and(eq(table.orgId, scope.orgId), eq(table.workspaceId, scope.workspaceId));

const distinct = (values: string[]) => [...new Set(values)];

/** The memory PR a memory last cited, as a list row carries it. */
export interface MemoryPrRef {
  id: string;
  publicId: string;
  number: number;
  url: string;
  status: "open" | "merged" | "closed";
}

/** One agent.memories row, with the memory PR it last cited. */
export interface WorkspaceMemoryRow {
  id: string;
  publicId: string;
  agentLineage: string | null;
  runPublicId: string | null;
  capture: MemoryCapture;
  statement: string;
  statementHash: string;
  kind: RecordKind;
  repos: string[] | null;
  appliesTo: string[] | null;
  tools: string[] | null;
  evidence: string[];
  source: string | null;
  label: string | null;
  summary: string | null;
  memoryType: string | null;
  state: MemoryState;
  useCount: number;
  lastUsedAt: Date | null;
  promotedLineage: string | null;
  retiredAt: Date | null;
  retiredReason: RetiredReason | null;
  createdAt: Date;
  memoryPr: MemoryPrRef | null;
}

/** What list_workspace_memories filters by. */
export interface WorkspaceMemoryFilter {
  states: readonly MemoryState[];
  harness?: MemoryHarness;
  agent?: string;
  repository?: string;
  type?: string;
}

/** One agent.memory_uses row. */
export interface WorkspaceMemoryUse {
  runPublicId: string | null;
  signal: MemoryUseSignal;
  count: number;
  usedAt: Date;
}

/** One agent.memory_prs row. */
export interface WorkspaceMemoryPr {
  id: string;
  publicId: string;
  provider: string;
  repository: string;
  branch: string;
  number: number;
  url: string;
  status: "open" | "merged" | "closed";
  records: MemoryPrRecord[];
  openedAt: Date;
  settledAt: Date | null;
}

/** What dismissing or restoring changed. */
export interface DismissResult {
  /** The public ids of the memories that changed state. */
  changed: string[];
  /** The ids left as they were, with the memory's state, or null when the workspace holds none. */
  skipped: Array<{ publicId: string; state: MemoryState | null }>;
  /** Rejection rows written by a dismissal, or deleted by a restore. */
  rejections: number;
}

/** The reads and writes the workspace memory handlers make. Tests pass fakes. */
export interface WorkspaceMemoryStore {
  /**
   * The matching memories in ranking order: uses, then the newest use, then
   * the newest capture, then the id. At most `max` rows, and `total` counts
   * every match.
   */
  listMemories(
    scope: MemoryScope,
    filter: WorkspaceMemoryFilter,
    max: number,
  ): Promise<{ rows: WorkspaceMemoryRow[]; total: number }>;
  /** The workspace's waiting memories. */
  countWaiting(scope: MemoryScope): Promise<number>;
  /** The memories with these public ids. An id the workspace does not hold is left out. */
  findMemories(
    scope: MemoryScope,
    publicIds: readonly string[],
  ): Promise<WorkspaceMemoryRow[]>;
  /** The memories with these row ids. */
  memoriesByIds(
    scope: MemoryScope,
    ids: readonly string[],
  ): Promise<WorkspaceMemoryRow[]>;
  /** A memory's uses, newest first, at most `limit`, and how many it holds. */
  listUses(
    scope: MemoryScope,
    memoryId: string,
    limit: number,
  ): Promise<{ uses: WorkspaceMemoryUse[]; total: number }>;
  /** A memory PR by its row id, or the newest opened one with this number. */
  findMemoryPr(
    scope: MemoryScope,
    by: { id: string } | { number: number },
  ): Promise<WorkspaceMemoryPr | null>;
  /**
   * Dismiss each waiting or in_pr memory, and add its statement hash to
   * `memory_rejections` at `at`. A hash already there keeps the memory PR
   * that rejected it and takes the new time.
   */
  dismissMemories(
    scope: MemoryScope,
    publicIds: readonly string[],
    at: Date,
  ): Promise<DismissResult>;
  /**
   * Bring each dismissed memory back: in_pr when its open memory PR still
   * cites it, else waiting. Each statement hash a dismissal wrote leaves
   * `memory_rejections` once no dismissed memory holds it. A hash a memory
   * PR rejected stays.
   */
  restoreMemories(
    scope: MemoryScope,
    publicIds: readonly string[],
  ): Promise<DismissResult>;
  /**
   * Add records to an open memory PR and move the waiting memories they
   * cite to in_pr, in one transaction. Returns false and writes nothing when
   * the PR is no longer open.
   */
  appendMemoryPrRecords(
    scope: MemoryScope,
    prId: string,
    records: readonly MemoryPrRecord[],
  ): Promise<boolean>;
}

/** A jsonb list of strings. Any other shape reads as null. */
function stringsOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

function prRecords(value: unknown): MemoryPrRecord[] {
  return Array.isArray(value) ? (value as MemoryPrRecord[]) : [];
}

const m = schema.memories;
const pr = schema.memoryPullRequests;

/** The columns a list row reads: the memory and the PR it last cited. */
const rowColumns = {
  id: m.id,
  publicId: m.publicId,
  agentLineage: m.agentLineage,
  runPublicId: m.runPublicId,
  capture: m.capture,
  statement: m.statement,
  statementHash: m.statementHash,
  kind: m.kind,
  repos: m.repos,
  appliesTo: m.appliesTo,
  tools: m.tools,
  evidence: m.evidence,
  source: m.source,
  label: m.label,
  summary: m.summary,
  memoryType: m.memoryType,
  state: m.state,
  useCount: m.useCount,
  lastUsedAt: m.lastUsedAt,
  promotedLineage: m.promotedLineage,
  retiredAt: m.retiredAt,
  retiredReason: m.retiredReason,
  createdAt: m.createdAt,
  prId: pr.id,
  prPublicId: pr.publicId,
  prNumber: pr.number,
  prUrl: pr.url,
  prStatus: pr.status,
};

type RawRow = {
  [K in keyof typeof rowColumns]: unknown;
};

function toRow(raw: RawRow): WorkspaceMemoryRow {
  const prId = raw.prId as string | null;
  return {
    id: raw.id as string,
    publicId: raw.publicId as string,
    agentLineage: raw.agentLineage as string | null,
    runPublicId: raw.runPublicId as string | null,
    capture: raw.capture as MemoryCapture,
    statement: raw.statement as string,
    statementHash: raw.statementHash as string,
    kind: raw.kind as RecordKind,
    repos: stringsOrNull(raw.repos),
    appliesTo: stringsOrNull(raw.appliesTo),
    tools: stringsOrNull(raw.tools),
    evidence: stringsOrNull(raw.evidence) ?? [],
    source: raw.source as string | null,
    label: raw.label as string | null,
    summary: raw.summary as string | null,
    memoryType: raw.memoryType as string | null,
    state: raw.state as MemoryState,
    useCount: raw.useCount as number,
    lastUsedAt: raw.lastUsedAt as Date | null,
    promotedLineage: raw.promotedLineage as string | null,
    retiredAt: raw.retiredAt as Date | null,
    retiredReason: raw.retiredReason as RetiredReason | null,
    createdAt: raw.createdAt as Date,
    memoryPr:
      prId === null
        ? null
        : {
            id: prId,
            publicId: raw.prPublicId as string,
            number: raw.prNumber as number,
            url: raw.prUrl as string,
            status: raw.prStatus as MemoryPrRef["status"],
          },
  };
}

/** The ranking order: uses, then the newest use, then the newest capture, then the id. */
const RANKING: SQL[] = [
  sql`${m.useCount} DESC`,
  sql`${m.lastUsedAt} DESC NULLS LAST`,
  sql`${m.createdAt} DESC`,
  sql`${m.id} ASC`,
];

function filterOf(scope: MemoryScope, filter: WorkspaceMemoryFilter) {
  const clauses: SQL[] = [inArray(m.state, [...filter.states])];
  if (filter.harness !== undefined)
    clauses.push(
      eq(m.capture, "local_gateway"),
      sql`starts_with(${m.source}, ${`${filter.harness}:`})`,
    );
  if (filter.agent !== undefined) clauses.push(eq(m.agentLineage, filter.agent));
  if (filter.repository !== undefined)
    clauses.push(
      sql`${m.repos} @> ${JSON.stringify([filter.repository])}::jsonb`,
    );
  if (filter.type !== undefined) clauses.push(eq(m.memoryType, filter.type));
  return and(scoped(m, scope), ...clauses);
}

/** The public ids, lowercased: public_id is citext, so the store compares without case. */
const lowered = (ids: readonly string[]) =>
  distinct(ids.map((id) => id.toLowerCase()));

async function lockByPublicId(
  tx: Tx,
  scope: MemoryScope,
  publicIds: string[],
) {
  return tx
    .select({
      id: m.id,
      publicId: m.publicId,
      state: m.state,
      statementHash: m.statementHash,
    })
    .from(m)
    .where(and(scoped(m, scope), inArray(m.publicId, publicIds)))
    .orderBy(asc(m.id))
    .for("update");
}

/** The ids the workspace holds in an allowed state, and the rest with their states. */
function sortByState(
  publicIds: string[],
  rows: Array<{ id: string; publicId: string; state: string; statementHash: string }>,
  allowed: ReadonlySet<string>,
) {
  const byPublicId = new Map(rows.map((row) => [row.publicId.toLowerCase(), row]));
  const eligible: typeof rows = [];
  const skipped: DismissResult["skipped"] = [];
  for (const publicId of publicIds) {
    const row = byPublicId.get(publicId);
    if (row === undefined) skipped.push({ publicId, state: null });
    else if (allowed.has(row.state)) eligible.push(row);
    else skipped.push({ publicId: row.publicId, state: row.state as MemoryState });
  }
  return { eligible, skipped };
}

export const postgresWorkspaceMemoryStore: WorkspaceMemoryStore = {
  async listMemories(scope, filter, max) {
    if (filter.states.length === 0) return { rows: [], total: 0 };
    const where = filterOf(scope, filter);
    return inScope(scope, async (tx) => {
      const rows = await tx
        .select(rowColumns)
        .from(m)
        .leftJoin(pr, eq(pr.id, m.memoryPrId))
        .where(where)
        .orderBy(...RANKING)
        .limit(max);
      const [total] = await tx.select({ total: count() }).from(m).where(where);
      return { rows: rows.map(toRow), total: total?.total ?? 0 };
    });
  },

  async countWaiting(scope) {
    const [row] = await inScope(scope, (tx) =>
      tx
        .select({ total: count() })
        .from(m)
        .where(and(scoped(m, scope), eq(m.state, "waiting"))),
    );
    return row?.total ?? 0;
  },

  async findMemories(scope, publicIds) {
    const ids = lowered(publicIds);
    if (ids.length === 0) return [];
    const rows = await inScope(scope, (tx) =>
      tx
        .select(rowColumns)
        .from(m)
        .leftJoin(pr, eq(pr.id, m.memoryPrId))
        .where(and(scoped(m, scope), inArray(m.publicId, ids))),
    );
    return rows.map(toRow);
  },

  async memoriesByIds(scope, ids) {
    const wanted = distinct([...ids]);
    if (wanted.length === 0) return [];
    const rows = await inScope(scope, (tx) =>
      tx
        .select(rowColumns)
        .from(m)
        .leftJoin(pr, eq(pr.id, m.memoryPrId))
        .where(and(scoped(m, scope), inArray(m.id, wanted))),
    );
    return rows.map(toRow);
  },

  async listUses(scope, memoryId, limit) {
    const u = schema.memoryUses;
    const where = and(scoped(u, scope), eq(u.memoryId, memoryId));
    return inScope(scope, async (tx) => {
      const uses = await tx
        .select({
          runPublicId: u.runPublicId,
          signal: u.signal,
          count: u.count,
          usedAt: u.usedAt,
        })
        .from(u)
        .where(where)
        .orderBy(desc(u.usedAt), asc(u.id))
        .limit(limit);
      const [total] = await tx.select({ total: count() }).from(u).where(where);
      return {
        uses: uses.map((use) => ({
          ...use,
          signal: use.signal as MemoryUseSignal,
        })),
        total: total?.total ?? 0,
      };
    });
  },

  async findMemoryPr(scope, by) {
    const match = "id" in by ? eq(pr.id, by.id) : eq(pr.number, by.number);
    const [row] = await inScope(scope, (tx) =>
      tx
        .select({
          id: pr.id,
          publicId: pr.publicId,
          provider: pr.provider,
          repository: pr.repository,
          branch: pr.branch,
          number: pr.number,
          url: pr.url,
          status: pr.status,
          records: pr.records,
          openedAt: pr.openedAt,
          settledAt: pr.settledAt,
        })
        .from(pr)
        .where(and(scoped(pr, scope), match))
        .orderBy(desc(pr.openedAt), desc(pr.id))
        .limit(1),
    );
    if (row === undefined) return null;
    return {
      ...row,
      status: row.status as WorkspaceMemoryPr["status"],
      records: prRecords(row.records),
    };
  },

  async dismissMemories(scope, publicIds, at) {
    const ids = lowered(publicIds);
    if (ids.length === 0) return { changed: [], skipped: [], rejections: 0 };
    const rj = schema.memoryRejections;
    return inScope(scope, async (tx) => {
      const rows = await lockByPublicId(tx, scope, ids);
      const { eligible, skipped } = sortByState(
        ids,
        rows,
        new Set(["waiting", "in_pr"]),
      );
      if (eligible.length === 0) return { changed: [], skipped, rejections: 0 };
      await tx
        .update(m)
        .set({ state: "dismissed" })
        .where(
          and(
            scoped(m, scope),
            inArray(
              m.id,
              eligible.map((row) => row.id),
            ),
          ),
        );
      const written = await tx
        .insert(rj)
        .values(
          distinct(eligible.map((row) => row.statementHash)).map(
            (statementHash) => ({
              orgId: scope.orgId,
              workspaceId: scope.workspaceId,
              statementHash,
              memoryPrId: null,
              rejectedAt: at,
            }),
          ),
        )
        .onConflictDoUpdate({
          target: [rj.workspaceId, rj.statementHash],
          set: { rejectedAt: at },
        })
        .returning({ id: rj.id });
      return {
        changed: eligible.map((row) => row.publicId),
        skipped,
        rejections: written.length,
      };
    });
  },

  async restoreMemories(scope, publicIds) {
    const ids = lowered(publicIds);
    if (ids.length === 0) return { changed: [], skipped: [], rejections: 0 };
    const rj = schema.memoryRejections;
    return inScope(scope, async (tx) => {
      const rows = await lockByPublicId(tx, scope, ids);
      const { eligible, skipped } = sortByState(ids, rows, new Set(["dismissed"]));
      if (eligible.length === 0) return { changed: [], skipped, rejections: 0 };
      // A memory its open memory PR still cites goes back to that PR.
      const citedByOpenPr = sql`EXISTS (SELECT 1 FROM ${pr} WHERE ${pr.id} = ${m.memoryPrId} AND ${pr.status} = 'open' AND ${pr.records} @> jsonb_build_array(jsonb_build_object('memoryIds', jsonb_build_array(${m.id}::text))))`;
      await tx
        .update(m)
        .set({
          state: sql`CASE WHEN ${citedByOpenPr} THEN 'in_pr' ELSE 'waiting' END`,
        })
        .where(
          and(
            scoped(m, scope),
            inArray(
              m.id,
              eligible.map((row) => row.id),
            ),
          ),
        );
      // Only the rows a dismissal wrote go, and only once no dismissed
      // memory holds the statement. A row a memory PR wrote names that PR.
      const deleted = await tx
        .delete(rj)
        .where(
          and(
            scoped(rj, scope),
            inArray(
              rj.statementHash,
              distinct(eligible.map((row) => row.statementHash)),
            ),
            sql`${rj.memoryPrId} IS NULL`,
            sql`NOT EXISTS (SELECT 1 FROM ${m} WHERE ${m.workspaceId} = ${rj.workspaceId} AND ${m.statementHash} = ${rj.statementHash} AND ${m.state} = 'dismissed')`,
          ),
        )
        .returning({ id: rj.id });
      return {
        changed: eligible.map((row) => row.publicId),
        skipped,
        rejections: deleted.length,
      };
    });
  },

  async appendMemoryPrRecords(scope, prId, records) {
    if (records.length === 0) return true;
    return inScope(scope, async (tx) => {
      const [open] = await tx
        .select({ records: pr.records })
        .from(pr)
        .where(and(scoped(pr, scope), eq(pr.id, prId), eq(pr.status, "open")))
        .for("update");
      if (open === undefined) return false;
      await tx
        .update(pr)
        .set({ records: [...prRecords(open.records), ...records] })
        .where(and(scoped(pr, scope), eq(pr.id, prId)));
      const cited = distinct(records.flatMap((record) => record.memoryIds));
      if (cited.length > 0)
        await tx
          .update(m)
          .set({ memoryPrId: prId, state: "in_pr" })
          .where(
            and(scoped(m, scope), inArray(m.id, cited), eq(m.state, "waiting")),
          );
      return true;
    });
  },
};
