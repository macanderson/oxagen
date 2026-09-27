// memory/store.ts: the Postgres side of the memory pipeline (ADR-206).
//
// Each method but listCurateWorkspaces opens the scope's tenant transaction
// and filters by the scope as well, so one missing policy still leaks no row.
// A method given an empty id or lineage list returns before any query.
import { schema, type Tx, withSystemDb, withTenantDb } from "@oxagen/database";
import type { RecordKind } from "@oxagen/oxagen/steering-repo/record";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, asc, count, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type {
  MemoryCapture,
  MemoryPrRecord,
  MemoryScope,
  MemoryStore,
  RecentReflection,
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
        .where(isNull(m.memoryPrId))),
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

  async insertReflection(scope, draft) {
    const t = schema.memoryReflections;
    const [row] = await inScope(scope, (tx) =>
      tx
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
        .returning({ id: t.id }),
    );
    return row?.id ?? null;
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
    const m = schema.memories;
    const written = await inScope(scope, (tx) =>
      tx
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
            reflectionId: reflectionId ?? null,
          })),
        )
        .onConflictDoNothing({ target: [m.workspaceId, m.dedupeKey] })
        .returning({ id: m.id }),
    );
    return written.length;
  },

  async countWaiting(scope) {
    const m = schema.memories;
    const [row] = await inScope(scope, (tx) =>
      tx
        .select({ total: count() })
        .from(m)
        .where(and(scoped(m, scope), isNull(m.memoryPrId))),
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
          reflectionId: m.reflectionId,
          memoryPrId: m.memoryPrId,
          createdAt: m.createdAt,
        })
        .from(m)
        .where(and(scoped(m, scope), isNull(m.memoryPrId)))
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
        reflectionId: row.reflectionId,
        memoryPrId: row.memoryPrId,
        createdAt: row.createdAt,
      }),
    );
  },

  async deleteMemories(scope, ids) {
    const targets = distinct(ids);
    if (targets.length === 0) return 0;
    const m = schema.memories;
    const deleted = await inScope(scope, (tx) =>
      tx
        .delete(m)
        .where(and(scoped(m, scope), inArray(m.id, targets)))
        .returning({ id: m.id }),
    );
    return deleted.length;
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
          .set({ memoryPrId: row.id })
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

      const purge = distinct(settlement.purgeMemoryIds);
      if (purge.length > 0)
        await tx.delete(m).where(and(scoped(m, scope), inArray(m.id, purge)));

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
