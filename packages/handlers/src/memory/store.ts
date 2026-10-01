// memory/store.ts: the Postgres side of the memory pipeline (ADR-206,
// ADR-245).
//
// Each method but listCurateWorkspaces opens the scope's tenant transaction
// and filters by the scope as well, so one missing policy still leaks no row.
// A method given an empty id, lineage, or use list returns before any query.
//
// A memory keeps its row for life (ADR-245). `state` moves it through
// waiting, in_pr, promoted, dismissed, and retired, and nothing here deletes
// a memory.
import { schema, type Tx, withSystemDb, withTenantDb } from "@oxagen/database";
import type { RecordKind } from "@oxagen/oxagen/steering-repo/record";
import { runInTenantScope } from "@oxagen/tenancy";
import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  notInArray,
  sql,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type {
  MemoryCapture,
  MemoryDraft,
  MemoryPrRecord,
  MemoryScope,
  MemoryState,
  MemoryStore,
  MemoryUseDraft,
  RecentReflection,
  RetiredReason,
  StoredMemory,
} from "./types";

const inScope = <T>(scope: MemoryScope, fn: (tx: Tx) => Promise<T>) =>
  runInTenantScope(scope, () => withTenantDb(fn));

const scoped = (
  table: { orgId: PgColumn; workspaceId: PgColumn },
  scope: MemoryScope,
) =>
  and(eq(table.orgId, scope.orgId), eq(table.workspaceId, scope.workspaceId));

const distinct = (values: string[]) => [...new Set(values)];

/**
 * Insert memories inside a transaction the caller holds, skipping any whose
 * dedupe key exists. Returns the count written.
 */
async function insertMemoryRows(
  tx: Tx,
  scope: MemoryScope,
  drafts: MemoryDraft[],
  reflectionId: string | null,
): Promise<number> {
  if (drafts.length === 0) return 0;
  const m = schema.memories;
  const written = await tx
    .insert(m)
    .values(
      drafts.map((draft) => ({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        agentLineage: draft.agentLineage,
        runPublicId: draft.runPublicId,
        capture: draft.capture,
        statement: draft.statement,
        statementHash: draft.statementHash,
        kind: draft.kind,
        repos: draft.repos,
        appliesTo: draft.appliesTo,
        tools: draft.tools,
        evidence: draft.evidence,
        source: draft.source,
        dedupeKey: draft.dedupeKey,
        label: draft.label ?? null,
        summary: draft.summary ?? null,
        memoryType: draft.memoryType ?? null,
        reflectionId,
      })),
    )
    .onConflictDoNothing({ target: [m.workspaceId, m.dedupeKey] })
    .returning({ id: m.id });
  return written.length;
}

/** The columns that retire a memory now, for `reason`. */
const retiredNow = (at: Date, reason: RetiredReason) => ({
  state: "retired" as const,
  retiredAt: at,
  retiredReason: reason,
});

/**
 * Bring a retired memory back: promoted when a record carries it, else
 * waiting. The SQL reads the row's own `promoted_lineage`.
 */
const backFromRetired = () => ({
  state: sql<MemoryState>`CASE WHEN ${schema.memories.promotedLineage} IS NULL THEN 'waiting' ELSE 'promoted' END`,
  retiredAt: null,
  retiredReason: null,
});

/** Retire one memory row inside the caller's transaction. */
async function retireRow(
  tx: Tx,
  scope: MemoryScope,
  id: string,
  at: Date,
  reason: RetiredReason,
): Promise<void> {
  const m = schema.memories;
  await tx
    .update(m)
    .set(retiredNow(at, reason))
    .where(and(scoped(m, scope), eq(m.id, id)));
}

/**
 * A jsonb list of strings. SQL null, JSON null, and any other shape read as
 * null.
 */
function stringsOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

/** The statement of each stored reflection/v1 lesson. */
function lessonStatements(value: unknown): RecentReflection["lessons"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((lesson: unknown) => {
    const statement =
      typeof lesson === "object" && lesson !== null
        ? (lesson as { statement?: unknown }).statement
        : undefined;
    return typeof statement === "string" ? [{ statement }] : [];
  });
}

/**
 * Set each lineage's recall and review time to `at`. A new row starts with no
 * recalls, and an existing row keeps its count. ON CONFLICT DO UPDATE refuses
 * to touch one row twice, so the lineages are made distinct first.
 */
async function stampRecallRows(
  tx: Tx,
  scope: MemoryScope,
  lineages: string[],
  at: Date,
): Promise<void> {
  const targets = distinct(lineages);
  if (targets.length === 0) return;
  const t = schema.memoryRecalls;
  await tx
    .insert(t)
    .values(
      targets.map((lineage) => ({
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        lineage,
        recallCount: 0,
        lastRecalledAt: at,
        reviewedAt: at,
      })),
    )
    .onConflictDoUpdate({
      target: [t.workspaceId, t.lineage],
      set: { lastRecalledAt: at, reviewedAt: at },
    });
}

export const postgresMemoryStore: MemoryStore = {
  async listCurateWorkspaces() {
    const m = schema.memories;
    const pr = schema.memoryPullRequests;
    const r = schema.memoryRecalls;
    // tenancy: the scheduled curator sweep is a deliberate cross-tenant read
    // of the shared plane. It selects orgId and workspaceId alone, filtered to
    // waiting memories, open memory PRs, and recall rows, and reads no other
    // column. The curator then opens each workspace in its own scope.
    const found = await withSystemDb(async (tx) => [
      ...(await tx
        .selectDistinct({ orgId: m.orgId, workspaceId: m.workspaceId })
        .from(m)
        .where(eq(m.state, "waiting"))),
      ...(await tx
        .selectDistinct({ orgId: pr.orgId, workspaceId: pr.workspaceId })
        .from(pr)
        .where(eq(pr.status, "open"))),
      ...(await tx
        .selectDistinct({ orgId: r.orgId, workspaceId: r.workspaceId })
        .from(r)),
    ]);
    const scopes = new Map<string, MemoryScope>();
    for (const { orgId, workspaceId } of found)
      scopes.set(`${orgId}:${workspaceId}`, { orgId, workspaceId });
    return [...scopes.values()];
  },

  async insertReflection(scope, draft, lessons = []) {
    const t = schema.memoryReflections;
    return inScope(scope, async (tx) => {
      const [row] = await tx
        .insert(t)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          runPublicId: draft.runPublicId,
          agentLineage: draft.agentLineage,
          source: draft.source,
          outcome: draft.outcome,
          summary: draft.summary,
          grades: draft.grades,
          lessons: draft.lessons,
          toolFeedback: draft.toolFeedback,
        })
        .onConflictDoNothing({ target: [t.workspaceId, t.runPublicId] })
        .returning({ id: t.id });
      if (row === undefined) return null;
      await insertMemoryRows(tx, scope, lessons, row.id);
      return row.id;
    });
  },

  async hasReflection(scope, runPublicId) {
    const t = schema.memoryReflections;
    const [row] = await inScope(scope, (tx) =>
      tx
        .select({ id: t.id })
        .from(t)
        .where(and(scoped(t, scope), eq(t.runPublicId, runPublicId)))
        .limit(1),
    );
    return row !== undefined;
  },

  async insertMemories(scope, drafts, reflectionId) {
    if (drafts.length === 0) return 0;
    return inScope(scope, (tx) =>
      insertMemoryRows(tx, scope, drafts, reflectionId ?? null),
    );
  },

  async replaceSourceMemory(scope, draft) {
    const m = schema.memories;
    const source = draft.source;
    const now = new Date();
    return inScope(scope, async (tx) => {
      if (source === null)
        return (await insertMemoryRows(tx, scope, [draft], null)) > 0;
      // Two sends from one source wait on each other, so the second reads the
      // waiting row the first wrote and never adds a second one.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`agent.memories:${scope.workspaceId}:${draft.capture}:${source}`}::text, 0))`,
      );
      const rows = await tx
        .select({
          id: m.id,
          dedupeKey: m.dedupeKey,
          state: m.state,
          retiredReason: m.retiredReason,
        })
        .from(m)
        .where(
          and(scoped(m, scope), eq(m.capture, draft.capture), eq(m.source, source)),
        )
        .orderBy(asc(m.createdAt), asc(m.id));
      const waiting = rows.filter((row) => row.state === "waiting");
      // A source written before ADR-238 can hold several waiting rows. The
      // oldest stays and takes the new text. The others hold text the file
      // no longer says, so they retire.
      const [kept, ...stale] = waiting;
      for (const row of stale) await retireRow(tx, scope, row.id, now, "deleted");
      const frontmatter = {
        label: draft.label ?? null,
        summary: draft.summary ?? null,
        memoryType: draft.memoryType ?? null,
      };

      const same = rows.find((row) => row.dedupeKey === draft.dedupeKey);
      if (same !== undefined) {
        // The source holds this statement already. Its frontmatter can still
        // have changed.
        await tx
          .update(m)
          .set(frontmatter)
          .where(and(scoped(m, scope), eq(m.id, same.id)));
        if (same.id === kept?.id) return false;
        // The file went back to a statement another row holds, so that row
        // holds the file's text again and the waiting row's text is gone.
        if (kept !== undefined)
          await retireRow(tx, scope, kept.id, now, "deleted");
        // A row retired because its file was gone comes back. A row retired
        // for no use comes back only when the file changed and changed back:
        // a daemon restart sends every file again, and that send alone does
        // not undo the retirement.
        const back =
          same.state === "retired" &&
          (same.retiredReason === "deleted" || kept !== undefined);
        if (back)
          await tx
            .update(m)
            .set(backFromRetired())
            .where(and(scoped(m, scope), eq(m.id, same.id)));
        return back;
      }

      if (kept === undefined)
        return (await insertMemoryRows(tx, scope, [draft], null)) > 0;
      await tx
        .update(m)
        .set({
          agentLineage: draft.agentLineage,
          runPublicId: draft.runPublicId,
          statement: draft.statement,
          statementHash: draft.statementHash,
          kind: draft.kind,
          repos: draft.repos,
          appliesTo: draft.appliesTo,
          tools: draft.tools,
          evidence: draft.evidence,
          dedupeKey: draft.dedupeKey,
          ...frontmatter,
        })
        .where(and(scoped(m, scope), eq(m.id, kept.id)));
      return true;
    });
  },

  async countWaiting(scope) {
    const m = schema.memories;
    const [row] = await inScope(scope, (tx) =>
      tx
        .select({ total: count() })
        .from(m)
        .where(and(scoped(m, scope), eq(m.state, "waiting"))),
    );
    return row?.total ?? 0;
  },

  async listWaiting(scope) {
    const m = schema.memories;
    const rows = await inScope(scope, (tx) =>
      tx
        .select({
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
          dedupeKey: m.dedupeKey,
          label: m.label,
          summary: m.summary,
          memoryType: m.memoryType,
          reflectionId: m.reflectionId,
          memoryPrId: m.memoryPrId,
          state: m.state,
          useCount: m.useCount,
          lastUsedAt: m.lastUsedAt,
          promotedLineage: m.promotedLineage,
          createdAt: m.createdAt,
        })
        .from(m)
        .where(and(scoped(m, scope), eq(m.state, "waiting")))
        .orderBy(asc(m.createdAt), asc(m.id)),
    );
    return rows.map(
      (row): StoredMemory => ({
        id: row.id,
        publicId: row.publicId,
        agentLineage: row.agentLineage,
        runPublicId: row.runPublicId,
        capture: row.capture as MemoryCapture,
        statement: row.statement,
        statementHash: row.statementHash,
        kind: row.kind as RecordKind,
        repos: stringsOrNull(row.repos),
        appliesTo: stringsOrNull(row.appliesTo),
        tools: stringsOrNull(row.tools),
        evidence: stringsOrNull(row.evidence) ?? [],
        source: row.source,
        dedupeKey: row.dedupeKey,
        label: row.label,
        summary: row.summary,
        memoryType: row.memoryType,
        reflectionId: row.reflectionId,
        memoryPrId: row.memoryPrId,
        state: row.state as MemoryState,
        useCount: row.useCount,
        lastUsedAt: row.lastUsedAt,
        promotedLineage: row.promotedLineage,
        createdAt: row.createdAt,
      }),
    );
  },

  async recordUses(scope, uses) {
    if (uses.length === 0) return { recorded: 0, unknown: 0 };
    const m = schema.memories;
    const u = schema.memoryUses;
    return inScope(scope, async (tx) => {
      // The memory each source holds now: its waiting memory, else its
      // newest memory that has not retired, else its newest memory.
      const targets = new Map<string, string>();
      for (const capture of distinct(uses.map((use) => use.capture))) {
        const sources = distinct(
          uses.filter((use) => use.capture === capture).map((use) => use.source),
        );
        const found = await tx
          .selectDistinctOn([m.source], { id: m.id, source: m.source })
          .from(m)
          .where(
            and(
              scoped(m, scope),
              eq(m.capture, capture),
              inArray(m.source, sources),
            ),
          )
          .orderBy(
            m.source,
            sql`(${m.state} = 'waiting') DESC`,
            sql`(${m.state} <> 'retired') DESC`,
            sql`${m.createdAt} DESC`,
            sql`${m.id} DESC`,
          );
        for (const row of found)
          if (row.source !== null) targets.set(`${capture}\n${row.source}`, row.id);
      }
      const memoryIds = distinct([...targets.values()]);
      if (memoryIds.length === 0) return { recorded: 0, unknown: uses.length };
      // Lock the memories first, so two reports for one memory recompute its
      // count one after the other and neither misses the other's uses.
      await tx
        .select({ id: m.id })
        .from(m)
        .where(and(scoped(m, scope), inArray(m.id, memoryIds)))
        .orderBy(asc(m.id))
        .for("update");

      // One row per memory, run, and signal. Uses that share one are merged
      // first, because one insert cannot update a row twice.
      const merged = new Map<
        string,
        { memoryId: string; use: MemoryUseDraft; count: number; usedAt: Date }
      >();
      let unknown = 0;
      for (const use of uses) {
        const memoryId = targets.get(`${use.capture}\n${use.source}`);
        if (memoryId === undefined) {
          unknown += 1;
          continue;
        }
        const key = `${memoryId}\n${use.runPublicId ?? ""}\n${use.signal}`;
        const prior = merged.get(key);
        if (prior === undefined) {
          merged.set(key, { memoryId, use, count: use.count, usedAt: use.usedAt });
          continue;
        }
        prior.count += use.count;
        if (use.usedAt > prior.usedAt) prior.usedAt = use.usedAt;
      }
      await tx
        .insert(u)
        .values(
          [...merged.values()].map((row) => ({
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            memoryId: row.memoryId,
            runPublicId: row.use.runPublicId,
            signal: row.use.signal,
            count: row.count,
            usedAt: row.usedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [u.memoryId, u.runPublicId, u.signal],
          set: {
            count: sql`${u.count} + excluded.count`,
            usedAt: sql`greatest(${u.usedAt}, excluded.used_at)`,
          },
        });

      // Recompute from the uses table, so the two always agree. A retired
      // memory that a run used comes back.
      await tx
        .update(m)
        .set({
          useCount: sql`(SELECT count(DISTINCT ${u.runPublicId}) + coalesce(sum(${u.count}) FILTER (WHERE ${u.runPublicId} IS NULL), 0) FROM ${u} WHERE ${u.memoryId} = ${m.id})::integer`,
          lastUsedAt: sql`(SELECT max(${u.usedAt}) FROM ${u} WHERE ${u.memoryId} = ${m.id})`,
          state: sql`CASE WHEN ${m.state} <> 'retired' THEN ${m.state} WHEN ${m.promotedLineage} IS NULL THEN 'waiting' ELSE 'promoted' END`,
          retiredAt: sql`CASE WHEN ${m.state} = 'retired' THEN NULL ELSE ${m.retiredAt} END`,
          retiredReason: sql`CASE WHEN ${m.state} = 'retired' THEN NULL ELSE ${m.retiredReason} END`,
        })
        .where(and(scoped(m, scope), inArray(m.id, memoryIds)));
      return { recorded: uses.length - unknown, unknown };
    });
  },

  async retireMissingSources(scope, scan, at) {
    const m = schema.memories;
    const seen = distinct(scan.seen);
    const retired = await inScope(scope, (tx) =>
      tx
        .update(m)
        .set(retiredNow(at, "deleted"))
        .where(
          and(
            scoped(m, scope),
            eq(m.capture, scan.capture),
            inArray(m.state, ["waiting", "promoted"]),
            sql`${m.agentLineage} IS NOT DISTINCT FROM ${scan.agentLineage}::text`,
            sql`starts_with(${m.source}, ${scan.prefix})`,
            ...(seen.length > 0 ? [notInArray(m.source, seen)] : []),
          ),
        )
        .returning({ id: m.id }),
    );
    return retired.length;
  },

  async retireUnused(scope, before, at) {
    const m = schema.memories;
    const retired = await inScope(scope, (tx) =>
      tx
        .update(m)
        .set(retiredNow(at, "unused"))
        .where(
          and(
            scoped(m, scope),
            inArray(m.state, ["waiting", "promoted"]),
            sql`coalesce(${m.lastUsedAt}, ${m.createdAt}) < ${before.toISOString()}::timestamptz`,
          ),
        )
        .returning({ id: m.id }),
    );
    return retired.length;
  },

  async linkMemories(scope, links) {
    if (links.length === 0) return 0;
    const m = schema.memories;
    const byLineage = new Map<string, string[]>();
    for (const link of links)
      byLineage.set(link.lineage, [
        ...(byLineage.get(link.lineage) ?? []),
        link.memoryId,
      ]);
    return inScope(scope, async (tx) => {
      let linked = 0;
      for (const [lineage, ids] of byLineage) {
        const rows = await tx
          .update(m)
          .set({ state: "promoted", promotedLineage: lineage })
          .where(
            and(
              scoped(m, scope),
              inArray(m.id, distinct(ids)),
              eq(m.state, "waiting"),
            ),
          )
          .returning({ id: m.id });
        linked += rows.length;
      }
      return linked;
    });
  },

  async listOpenPrs(scope) {
    const pr = schema.memoryPullRequests;
    const rows = await inScope(scope, (tx) =>
      tx
        .select({
          id: pr.id,
          provider: pr.provider,
          repository: pr.repository,
          branch: pr.branch,
          number: pr.number,
          url: pr.url,
          records: pr.records,
          openedAt: pr.openedAt,
        })
        .from(pr)
        .where(and(scoped(pr, scope), eq(pr.status, "open")))
        .orderBy(asc(pr.openedAt), asc(pr.id)),
    );
    return rows.map((row) => ({
      ...row,
      records: Array.isArray(row.records)
        ? (row.records as MemoryPrRecord[])
        : [],
    }));
  },

  async openedPrFrom(scope, branch) {
    const pr = schema.memoryPullRequests;
    const [row] = await inScope(scope, (tx) =>
      tx
        .select({ id: pr.id })
        .from(pr)
        .where(and(scoped(pr, scope), eq(pr.branch, branch)))
        .limit(1),
    );
    return row !== undefined;
  },

  async insertMemoryPr(scope, input) {
    const pr = schema.memoryPullRequests;
    const m = schema.memories;
    return inScope(scope, async (tx) => {
      const [row] = await tx
        .insert(pr)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          provider: input.provider,
          repository: input.repository,
          branch: input.branch,
          number: input.number,
          url: input.url,
          records: input.records,
        })
        .returning({ id: pr.id });
      if (!row) throw new Error("The memory_prs insert returned no row.");
      const cited = distinct(input.records.flatMap((r) => r.memoryIds));
      if (cited.length > 0)
        await tx
          .update(m)
          .set({ memoryPrId: row.id, state: "in_pr" })
          .where(and(scoped(m, scope), inArray(m.id, cited)));
      return row.id;
    });
  },

  async settlePr(scope, settlement) {
    const pr = schema.memoryPullRequests;
    const m = schema.memories;
    const rj = schema.memoryRejections;
    const at = settlement.settledAt;
    await inScope(scope, async (tx) => {
      // Only an open PR settles. A second settle of the same PR, or one that
      // lost a race with another curator, finds no open row and writes nothing.
      const settled = await tx
        .update(pr)
        .set({ status: settlement.status, settledAt: at })
        .where(
          and(
            scoped(pr, scope),
            eq(pr.id, settlement.prId),
            eq(pr.status, "open"),
          ),
        )
        .returning({ id: pr.id });
      if (settled.length === 0) return;

      // Only memories this PR still holds move. A memory a person dismissed
      // while the PR was open stays dismissed.
      const heldByPr = and(
        scoped(m, scope),
        eq(m.memoryPrId, settlement.prId),
        eq(m.state, "in_pr"),
      );
      for (const { lineage, memoryIds } of settlement.promoted) {
        const ids = distinct(memoryIds);
        if (ids.length === 0) continue;
        await tx
          .update(m)
          .set({ state: "promoted", promotedLineage: lineage })
          .where(and(heldByPr, inArray(m.id, ids)));
      }
      const returned = distinct(settlement.returnedMemoryIds);
      if (returned.length > 0) {
        // A memory file edited while its memory sat in the PR has a newer
        // waiting memory with the file's text, so the returned memory's text
        // is gone from the file and it retires. Every other memory waits.
        const replaced = sql`${m.capture} = 'local_gateway' AND EXISTS (SELECT 1 FROM ${m} AS w WHERE w.workspace_id = ${m.workspaceId} AND w.capture = ${m.capture} AND w.source = ${m.source} AND w.state = 'waiting' AND w.id <> ${m.id})`;
        await tx
          .update(m)
          .set({
            state: sql`CASE WHEN ${replaced} THEN 'retired' ELSE 'waiting' END`,
            retiredAt: sql`CASE WHEN ${replaced} THEN ${at.toISOString()}::timestamptz END`,
            retiredReason: sql`CASE WHEN ${replaced} THEN 'deleted' END`,
          })
          .where(and(heldByPr, inArray(m.id, returned)));
      }

      const hashes = distinct(settlement.rejectedHashes);
      if (hashes.length > 0)
        await tx
          .insert(rj)
          .values(
            hashes.map((statementHash) => ({
              orgId: scope.orgId,
              workspaceId: scope.workspaceId,
              statementHash,
              memoryPrId: settlement.prId,
              rejectedAt: at,
            })),
          )
          .onConflictDoUpdate({
            target: [rj.workspaceId, rj.statementHash],
            set: { rejectedAt: at, memoryPrId: settlement.prId },
          });

      await stampRecallRows(
        tx,
        scope,
        [...settlement.mergedLineages, ...settlement.reviewedLineages],
        at,
      );
    });
  },

  async listRejections(scope) {
    const rj = schema.memoryRejections;
    return inScope(scope, (tx) =>
      tx
        .select({ statementHash: rj.statementHash, rejectedAt: rj.rejectedAt })
        .from(rj)
        .where(scoped(rj, scope))
        .orderBy(asc(rj.rejectedAt), asc(rj.statementHash)),
    );
  },

  async listRecalls(scope) {
    const t = schema.memoryRecalls;
    return inScope(scope, (tx) =>
      tx
        .select({
          lineage: t.lineage,
          recallCount: t.recallCount,
          lastRecalledAt: t.lastRecalledAt,
          reviewedAt: t.reviewedAt,
        })
        .from(t)
        .where(scoped(t, scope))
        .orderBy(asc(t.lineage)),
    );
  },

  async stampRecalls(scope, lineages, at) {
    if (lineages.length === 0) return;
    await inScope(scope, (tx) => stampRecallRows(tx, scope, lineages, at));
  },

  async bumpRecalls(scope, lineages, at) {
    const targets = distinct(lineages);
    if (targets.length === 0) return;
    const t = schema.memoryRecalls;
    await inScope(scope, (tx) =>
      tx
        .insert(t)
        .values(
          targets.map((lineage) => ({
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            lineage,
            recallCount: 1,
            lastRecalledAt: at,
            reviewedAt: at,
          })),
        )
        .onConflictDoUpdate({
          target: [t.workspaceId, t.lineage],
          set: { recallCount: sql`${t.recallCount} + 1`, lastRecalledAt: at },
        }),
    );
  },

  async listReflectionsSince(scope, since) {
    const t = schema.memoryReflections;
    const rows = await inScope(scope, (tx) =>
      tx
        .select({ createdAt: t.createdAt, lessons: t.lessons })
        .from(t)
        .where(and(scoped(t, scope), gte(t.createdAt, since)))
        .orderBy(asc(t.createdAt), asc(t.id)),
    );
    return rows.map((row) => ({
      createdAt: row.createdAt,
      lessons: lessonStatements(row.lessons),
    }));
  },
};
