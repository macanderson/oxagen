// context.steering.store.ts — the Postgres seam under the steering handlers
// (ADR-061): the published registry (agent.context_records and its versions),
// the promotions ledger, the proposals and the appended records. Every
// handler takes a `SteeringStore`; this file is the one that runs SQL, inside
// the tenant scope the kernel entered. The tests run the handlers against the
// in-memory store in context.steering.test-support.ts.
import {
  ambientPlaneKey,
  CONTEXT_VERSION_CLASSIFICATION_COLUMN,
  hasColumnFresh,
  isUniqueViolation,
  schema,
  withTenantDb,
} from "@oxagen/database";
import { contextRecordLabel } from "@oxagen/oxagen/context-record-label";
import { HandlerError } from "@oxagen/oxagen";
import type {
  CheckResult,
  ProposalStatus,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  max,
  or,
  sql,
} from "drizzle-orm";
import { canonicalJson, sha256Hex } from "./registry-digest";

interface SteeringScope {
  orgId: string;
  workspaceId: string;
}

export type ProposalRow = Omit<
  typeof schema.contextProposals.$inferSelect,
  "checks" | "title" | "label"
> & { checks: CheckResult[]; title?: string | null; label?: string | null };

type ProposalInsert = Pick<
  ProposalRow,
  | "orgId"
  | "workspaceId"
  | "lineageId"
  | "kind"
  | "force"
  | "constraintEffect"
  | "sharingScope"
  | "statement"
  | "rationale"
  | "source"
  | "supportRuns"
  | "supportAgents"
  | "supportingRecordIds"
  | "evidenceLinks"
  | "createdById"
> & { title?: string | null; label?: string | null };

/** The columns a handler may change after insert. */
type ProposalPatch = Partial<
  Pick<
    ProposalRow,
    | "status"
    | "governanceMode"
    | "provider"
    | "repository"
    | "baseRef"
    | "branch"
    | "path"
    | "prNumber"
    | "prUrl"
    | "headSha"
    | "stampedRecordId"
    | "recordHash"
    | "checks"
    | "dismissedAt"
    | "dismissedReason"
    | "updatedById"
  >
>;

export type PublishedRecordRow = Omit<
  typeof schema.contextRecords.$inferSelect,
  "label"
> & {
  label?: string | null;
  version: number | null;
  checksum: string | null;
};

/**
 * What one record has actually done, rolled up over the context-use appends
 * the runs wrote (spec §9 kinds `context_use` and `context_use_feedback`).
 *
 * Both counts are DISTINCT RUNS, not appends: a run that renders the same
 * record into eight turns used it once, and counting the turns would let a
 * chatty run outvote eight quiet ones. The run comes out of the append's
 * `source_refs`, where a frame ref is `frame:<run>/<seq>`.
 *
 * The whole thing is nullable, and the null is the point: a workspace whose
 * runs have never written a context-use append has no rollup, which is a
 * different fact from a record nothing used. Reporting the first as `0` would
 * tell a reader that the rule they are looking at was ignored, when the truth
 * is that nothing is counting.
 */
export interface RecordEffect {
  /** Runs that rendered this record into their bundle. */
  rendered: number;
  /** Runs that reported back on it — §9's `context_use_feedback`. */
  cited: number;
}

interface PublishedRecordVersion {
  publicId: string;
  version: number;
  checksum: string;
  isLatest: boolean;
  publishedAt: Date | null;
}

export type AppendRow = typeof schema.contextAppends.$inferSelect;

type AppendInsert = Pick<
  AppendRow,
  | "orgId"
  | "workspaceId"
  | "kind"
  | "lineageId"
  | "statement"
  | "sharingScope"
  | "recordHash"
  | "sourceRefs"
  | "evidenceLinks"
  | "proposalId"
  | "createdById"
>;

interface RecordFilter {
  kind?: string;
  sharingScope?: string;
  status?: string;
  lineageId?: string;
}

export interface Page {
  limit: number;
  offset: number;
}

interface PublishMergeInput {
  scope: SteeringScope;
  proposal: ProposalRow;
  /** The committed file's text: the version body. */
  body: string;
  /** SHA-256 hex over the body (the registry's immutability checksum). */
  checksum: string;
  commitSha: string;
  path: string;
  mergedAt: Date;
  mergedByUserId: string | null;
  /** The governance mode the merge ran under, recorded as the ledger's policy version. */
  policyVersion: string;
}

interface PublishMergeResult {
  recordId: string;
  recordPublicId: string;
  versionId: string;
  version: number;
  promotion: { id: string; publicId: string; seq: number; chainDigest: string };
  /** The ledger length before this promotion event. */
  ledgerBefore: number;
}

export interface SteeringStore {
  insertProposal(
    values: ProposalInsert,
    options?: { createOnly: boolean },
  ): Promise<ProposalRow>;
  findProposal(
    scope: SteeringScope,
    publicId: string,
  ): Promise<ProposalRow | null>;
  /** Another proposal with an open PR on this lineage, if any. */
  findOpenPrOnLineage(
    scope: SteeringScope,
    lineageId: string,
    excludingId: string,
  ): Promise<ProposalRow | null>;
  listProposals(
    scope: SteeringScope,
    filter: { status?: string; lineageId?: string },
    page: Page,
  ): Promise<{ rows: ProposalRow[]; total: number }>;
  /**
   * Apply the patch only while the proposal's status is one of `from` and,
   * with `guard`, its head is still `guard.headSha`; a proposal another call
   * moved on is left as it is and the write throws `conflict` with the reason
   * `proposal_<its status>`, or `head_moved` when only the head differs.
   */
  updateProposal(
    id: string,
    patch: ProposalPatch,
    from: readonly ProposalStatus[],
    guard?: { headSha: string },
  ): Promise<ProposalRow>;

  listRecords(
    scope: SteeringScope,
    filter: RecordFilter,
    page: Page,
  ): Promise<{ rows: PublishedRecordRow[]; total: number }>;
  findRecord(
    scope: SteeringScope,
    idOrLineage: string,
  ): Promise<{
    record: PublishedRecordRow;
    versions: PublishedRecordVersion[];
    publishedBy: { proposalPublicId: string; prUrl: string | null } | null;
  } | null>;
  /**
   * The effect counters for one lineage, or null when this workspace has no
   * context-use rollup at all. See `RecordEffect` for why the absence is a
   * case of its own rather than a row of zeros.
   */
  recordEffect(
    scope: SteeringScope,
    lineageId: string,
  ): Promise<RecordEffect | null>;
  /** The active records in the registry, for the conflict check. */
  listActiveRecords(scope: SteeringScope): Promise<PublishedRecordRow[]>;
  /** The promotions ledger length for the workspace: its steering version. */
  ledgerLength(scope: SteeringScope): Promise<number>;
  /**
   * The newest publishing commit on the production branch, for the steering
   * freshness check: a developer's checkout that cannot reach this commit is
   * reading records that are no longer the ones in force. Null until a
   * Context PR has merged (a record published through
   * `publish_context_record` carries no commit).
   */
  latestPublication(scope: SteeringScope): Promise<{
    commitSha: string;
    /**
     * Every distinct commit published at the newest instant, `commitSha`
     * among them. GitHub reports a merge to the second, so two merges can
     * share one, and no column here says which landed later on the branch.
     * The store does not guess. It hands back all of them, and a checkout is
     * current only when it can reach each one: git knows the ancestry.
     */
    commitShas: string[];
    publishedAt: Date;
  } | null>;
  /**
   * `ledgerLength` and `latestPublication` in one transaction, for the
   * freshness read: a publication committing between two independent reads
   * could pair the new steering version with the old `headCommit`, and a
   * checkout stalled at that old commit would then read as current under
   * the new version. One transaction gives both counts the same snapshot.
   */
  versionAndPublication(scope: SteeringScope): Promise<{
    version: number;
    publication: {
      commitSha: string;
      commitShas: string[];
      publishedAt: Date;
    } | null;
  }>;

  /** Idempotent on (workspace, record_hash): `appended` is false on a repeat. */
  insertAppend(
    values: AppendInsert,
  ): Promise<{ row: AppendRow; appended: boolean }>;
  findAppend(scope: SteeringScope, publicId: string): Promise<AppendRow | null>;
  findAppendByHash(
    scope: SteeringScope,
    recordHash: string,
  ): Promise<AppendRow | null>;
  /** The proposal an append references, by uuid, for get_record. */
  findProposalById(id: string): Promise<ProposalRow | null>;
  /** The public ids a merged proposal's uuids point at, for the PR view. */
  mergedRefs(
    row: ProposalRow,
  ): Promise<{ promotionEventPublicId: string; recordPublicId: string } | null>;

  /**
   * The publication, in one transaction: upsert the registry record and its
   * new version, append the promotion event to the hash-chained ledger, and
   * move the proposal from `checks_passed` to `merged`. A proposal no longer
   * at `checks_passed` (a concurrent call published it) rolls the whole
   * transaction back with `already_merged`.
   */
  publishMerge(input: PublishMergeInput): Promise<PublishMergeResult>;
}

/** A guarded proposal write found the proposal at `status`. */
export function proposalMoved(publicId: string, status: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: `proposal_${status}`,
    message: `Proposal ${publicId} is ${status}`,
  });
}

/** A write tied to the checks on `expected` found the proposal at another head. */
export function headMoved(
  publicId: string,
  headSha: string | null,
  expected: string,
): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "head_moved",
    message: `Proposal ${publicId} moved to ${headSha ?? "no commit"} while the checks ran on ${expected}`,
  });
}

/** The publication found the proposal past `checks_passed`. */
export function alreadyMerged(proposalPublicId: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "already_merged",
    message: `${proposalPublicId} was published by another call`,
  });
}

const asChecks = (v: unknown): CheckResult[] =>
  Array.isArray(v) ? (v as CheckResult[]) : [];

function toProposal(
  row: typeof schema.contextProposals.$inferSelect,
): ProposalRow {
  return { ...row, checks: asChecks(row.checks) };
}

function scoped(scope: SteeringScope) {
  return and(
    eq(schema.contextProposals.orgId, scope.orgId),
    eq(schema.contextProposals.workspaceId, scope.workspaceId),
  );
}

const OPEN_PR_STATUSES = [
  "pr_open",
  "checks_running",
  "checks_passed",
  "checks_failed",
] as const;

const recordColumns = {
  ...getTableColumns(schema.contextRecords),
  version: schema.contextRecordVersions.versionNumber,
  checksum: schema.contextRecordVersions.checksum,
};

export const postgresSteeringStore: SteeringStore = {
  async insertProposal(values, options) {
    return withTenantDb(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${values.workspaceId}:${values.lineageId.toLowerCase()}`}, 0))`,
      );
      if (options?.createOnly) {
        const [record] = await tx
          .select({ id: schema.contextRecords.id })
          .from(schema.contextRecords)
          .where(
            and(
              eq(schema.contextRecords.orgId, values.orgId),
              eq(schema.contextRecords.workspaceId, values.workspaceId),
              eq(schema.contextRecords.slug, values.lineageId),
            ),
          )
          .limit(1);
        const [proposal] = await tx
          .select({ id: schema.contextProposals.id })
          .from(schema.contextProposals)
          .where(
            and(
              eq(schema.contextProposals.orgId, values.orgId),
              eq(schema.contextProposals.workspaceId, values.workspaceId),
              eq(schema.contextProposals.lineageId, values.lineageId),
            ),
          )
          .limit(1);
        if (record || proposal)
          throw new HandlerError({
            code: "conflict",
            reason: "clone_name_taken",
            message:
              "This lineage already belongs to a record or proposal. Refresh the clone draft.",
          });
      }
      const [row] = await tx
        .insert(schema.contextProposals)
        .values(values)
        .returning();
      if (!row)
        throw new Error("[context.steering] proposal insert returned no row");
      return toProposal(row);
    });
  },

  async findProposal(scope, publicId) {
    const [row] = await withTenantDb((tx) =>
      tx
        .select()
        .from(schema.contextProposals)
        .where(
          and(scoped(scope), eq(schema.contextProposals.publicId, publicId)),
        )
        .limit(1),
    );
    return row ? toProposal(row) : null;
  },

  async findProposalById(id) {
    const [row] = await withTenantDb((tx) =>
      tx
        .select()
        .from(schema.contextProposals)
        .where(eq(schema.contextProposals.id, id))
        .limit(1),
    );
    return row ? toProposal(row) : null;
  },

  async mergedRefs(row) {
    if (!row.promotionEventId || !row.publishedRecordId) return null;
    return withTenantDb(async (tx) => {
      const [promotion] = await tx
        .select({ publicId: schema.contextPromotions.publicId })
        .from(schema.contextPromotions)
        .where(eq(schema.contextPromotions.id, row.promotionEventId!))
        .limit(1);
      const [record] = await tx
        .select({ publicId: schema.contextRecords.publicId })
        .from(schema.contextRecords)
        .where(eq(schema.contextRecords.id, row.publishedRecordId!))
        .limit(1);
      if (!promotion || !record) return null;
      return {
        promotionEventPublicId: promotion.publicId,
        recordPublicId: record.publicId,
      };
    });
  },

  async findOpenPrOnLineage(scope, lineageId, excludingId) {
    const [row] = await withTenantDb((tx) =>
      tx
        .select()
        .from(schema.contextProposals)
        .where(
          and(
            scoped(scope),
            eq(schema.contextProposals.lineageId, lineageId),
            sql`${schema.contextProposals.status} IN (${sql.join(
              OPEN_PR_STATUSES.map((s) => sql`${s}`),
              sql`, `,
            )})`,
            sql`${schema.contextProposals.id} <> ${excludingId}`,
          ),
        )
        .limit(1),
    );
    return row ? toProposal(row) : null;
  },

  async listProposals(scope, filter, page) {
    const where = and(
      scoped(scope),
      filter.status
        ? eq(schema.contextProposals.status, filter.status)
        : undefined,
      filter.lineageId
        ? eq(schema.contextProposals.lineageId, filter.lineageId)
        : undefined,
    );
    return withTenantDb(async (tx) => {
      const [c] = await tx
        .select({ total: count() })
        .from(schema.contextProposals)
        .where(where);
      const rows = await tx
        .select()
        .from(schema.contextProposals)
        .where(where)
        .orderBy(
          desc(schema.contextProposals.createdAt),
          desc(schema.contextProposals.id),
        )
        .limit(page.limit)
        .offset(page.offset);
      return { rows: rows.map(toProposal), total: c?.total ?? 0 };
    });
  },

  async updateProposal(id, patch, from, guard) {
    return withTenantDb(async (tx) => {
      const [row] = await tx
        .update(schema.contextProposals)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(
          and(
            eq(schema.contextProposals.id, id),
            inArray(schema.contextProposals.status, [...from]),
            guard
              ? eq(schema.contextProposals.headSha, guard.headSha)
              : undefined,
          ),
        )
        .returning();
      if (row) return toProposal(row);
      const [current] = await tx
        .select({
          publicId: schema.contextProposals.publicId,
          status: schema.contextProposals.status,
          headSha: schema.contextProposals.headSha,
        })
        .from(schema.contextProposals)
        .where(eq(schema.contextProposals.id, id))
        .limit(1);
      if (!current)
        throw new Error(
          `[context.steering] proposal ${id} vanished during update`,
        );
      if (
        guard &&
        from.includes(current.status as ProposalStatus) &&
        current.headSha !== guard.headSha
      )
        throw headMoved(current.publicId, current.headSha, guard.headSha);
      throw proposalMoved(current.publicId, current.status);
    });
  },

  async listRecords(scope, filter, page) {
    const where = and(
      eq(schema.contextRecords.orgId, scope.orgId),
      eq(schema.contextRecords.workspaceId, scope.workspaceId),
      isNull(schema.contextRecords.deletedAt),
      filter.kind ? eq(schema.contextRecords.kind, filter.kind) : undefined,
      filter.sharingScope
        ? eq(schema.contextRecords.sharingScope, filter.sharingScope)
        : undefined,
      filter.status
        ? eq(schema.contextRecords.status, filter.status)
        : undefined,
      filter.lineageId
        ? eq(schema.contextRecords.slug, filter.lineageId)
        : undefined,
    );
    return withTenantDb(async (tx) => {
      const [c] = await tx
        .select({ total: count() })
        .from(schema.contextRecords)
        .where(where);
      const rows = await tx
        .select(recordColumns)
        .from(schema.contextRecords)
        .leftJoin(
          schema.contextRecordVersions,
          eq(
            schema.contextRecordVersions.id,
            schema.contextRecords.activeVersionId,
          ),
        )
        .where(where)
        .orderBy(
          desc(schema.contextRecords.updatedAt),
          asc(schema.contextRecords.slug),
        )
        .limit(page.limit)
        .offset(page.offset);
      return { rows, total: c?.total ?? 0 };
    });
  },

  async findRecord(scope, idOrLineage) {
    return withTenantDb(async (tx) => {
      const [record] = await tx
        .select(recordColumns)
        .from(schema.contextRecords)
        .leftJoin(
          schema.contextRecordVersions,
          eq(
            schema.contextRecordVersions.id,
            schema.contextRecords.activeVersionId,
          ),
        )
        .where(
          and(
            eq(schema.contextRecords.orgId, scope.orgId),
            eq(schema.contextRecords.workspaceId, scope.workspaceId),
            isNull(schema.contextRecords.deletedAt),
            or(
              eq(schema.contextRecords.publicId, idOrLineage),
              eq(schema.contextRecords.slug, idOrLineage),
            ),
          ),
        )
        .limit(1);
      if (!record) return null;
      const versions = await tx
        .select({
          publicId: schema.contextRecordVersions.publicId,
          version: schema.contextRecordVersions.versionNumber,
          checksum: schema.contextRecordVersions.checksum,
          isLatest: schema.contextRecordVersions.isLatest,
          publishedAt: schema.contextRecordVersions.publishedAt,
        })
        .from(schema.contextRecordVersions)
        .where(eq(schema.contextRecordVersions.recordId, record.id))
        .orderBy(desc(schema.contextRecordVersions.versionNumber));
      const [publisher] = await tx
        .select({
          publicId: schema.contextProposals.publicId,
          prUrl: schema.contextProposals.prUrl,
        })
        .from(schema.contextProposals)
        .where(
          and(
            eq(schema.contextProposals.publishedRecordId, record.id),
            eq(schema.contextProposals.status, "merged"),
          ),
        )
        .orderBy(desc(schema.contextProposals.mergedAt))
        .limit(1);
      return {
        record,
        versions,
        publishedBy: publisher
          ? { proposalPublicId: publisher.publicId, prUrl: publisher.prUrl }
          : null,
      };
    });
  },

  async recordEffect(scope, lineageId) {
    return withTenantDb(async (tx) => {
      // One statement, two questions, so they cannot disagree: does this
      // workspace record context use at all, and what did this lineage do.
      // Asked as two round trips, a run appending between them could report
      // "no rollup" for a workspace that has one.
      //
      // The run comes out of `source_refs`, where §9 spells a frame ref
      // `frame:<run>/<seq>`. Refs that are not frame refs — a record id, an
      // evidence digest — match nothing and drop out, which is why the run is
      // extracted rather than the array counted.
      const result = await tx.execute(sql`
        select
          count(*) filter (
            where ${schema.contextAppends.kind} in ('context_use', 'context_use_feedback')
          ) as scope_total,
          count(distinct ref.run) filter (
            where ${schema.contextAppends.kind} = 'context_use'
              and ${schema.contextAppends.lineageId} = ${lineageId}
          ) as rendered,
          count(distinct ref.run) filter (
            where ${schema.contextAppends.kind} = 'context_use_feedback'
              and ${schema.contextAppends.lineageId} = ${lineageId}
          ) as cited
        from ${schema.contextAppends}
        left join lateral (
          select substring(source_ref from 'frame:([^/]+)/') as run
          from unnest(${schema.contextAppends.sourceRefs}) as source_ref
        ) as ref on true
        where ${schema.contextAppends.orgId} = ${scope.orgId}
          and ${schema.contextAppends.workspaceId} = ${scope.workspaceId}
      `);
      const [row] = [...result] as {
        scope_total: string | number;
        rendered: string | number;
        cited: string | number;
      }[];
      if (!row || Number(row.scope_total) === 0) return null;
      return { rendered: Number(row.rendered), cited: Number(row.cited) };
    });
  },

  async listActiveRecords(scope) {
    return withTenantDb((tx) =>
      tx
        .select(recordColumns)
        .from(schema.contextRecords)
        .leftJoin(
          schema.contextRecordVersions,
          eq(
            schema.contextRecordVersions.id,
            schema.contextRecords.activeVersionId,
          ),
        )
        .where(
          and(
            eq(schema.contextRecords.orgId, scope.orgId),
            eq(schema.contextRecords.workspaceId, scope.workspaceId),
            eq(schema.contextRecords.status, "active"),
            isNull(schema.contextRecords.deletedAt),
          ),
        ),
    );
  },

  async latestPublication(scope) {
    const published = and(
      eq(schema.contextRecords.orgId, scope.orgId),
      eq(schema.contextRecords.workspaceId, scope.workspaceId),
      isNotNull(schema.contextRecords.commitSha),
      isNotNull(schema.contextRecords.publishedAt),
      isNull(schema.contextRecords.deletedAt),
    );
    const rows = await withTenantDb((tx) => {
      const newestInstant = tx
        .select({ at: max(schema.contextRecords.publishedAt) })
        .from(schema.contextRecords)
        .where(published);
      return (
        tx
          .select({
            commitSha: schema.contextRecords.commitSha,
            publishedAt: schema.contextRecords.publishedAt,
          })
          .from(schema.contextRecords)
          // Every publication at the newest instant, in one round trip.
          // `published_at` is GitHub's merge instant (see `merge_context_pr`),
          // so a publication retried after a later merge still sorts earlier.
          //
          // GitHub reports that instant to the second, and two PRs can merge
          // inside one. An earlier version broke the tie on `id`, reading it
          // as insert order. It is not publication order: a retried earlier
          // merge inserts last, and a new version of an existing lineage
          // keeps that lineage's old row and its old id. Either way the
          // earlier commit could win, and a checkout at that commit read as
          // current while it lacked the later record. Nothing stored here
          // orders two commits on the branch, so the tie is returned whole.
          .where(
            and(
              published,
              eq(schema.contextRecords.publishedAt, sql`(${newestInstant})`),
            ),
          )
          // Stable, so `commitSha` does not flip between two reads.
          .orderBy(desc(schema.contextRecords.id))
      );
    });
    const newest = rows[0];
    if (!newest?.commitSha || !newest.publishedAt) return null;
    const commitShas = [
      ...new Set(
        rows.flatMap((row) => (row.commitSha === null ? [] : [row.commitSha])),
      ),
    ];
    return {
      commitSha: newest.commitSha,
      commitShas,
      publishedAt: newest.publishedAt,
    };
  },

  async ledgerLength(scope) {
    const [c] = await withTenantDb((tx) =>
      tx
        .select({ total: count() })
        .from(schema.contextPromotions)
        .where(
          and(
            eq(schema.contextPromotions.orgId, scope.orgId),
            eq(schema.contextPromotions.workspaceId, scope.workspaceId),
          ),
        ),
    );
    return c?.total ?? 0;
  },

  async versionAndPublication(scope) {
    const published = and(
      eq(schema.contextRecords.orgId, scope.orgId),
      eq(schema.contextRecords.workspaceId, scope.workspaceId),
      isNotNull(schema.contextRecords.commitSha),
      isNotNull(schema.contextRecords.publishedAt),
      isNull(schema.contextRecords.deletedAt),
    );
    const { countRow, rows } = await withTenantDb(async (tx) => {
      const newestInstant = tx
        .select({ at: max(schema.contextRecords.publishedAt) })
        .from(schema.contextRecords)
        .where(published);
      const [countRow] = await tx
        .select({ total: count() })
        .from(schema.contextPromotions)
        .where(
          and(
            eq(schema.contextPromotions.orgId, scope.orgId),
            eq(schema.contextPromotions.workspaceId, scope.workspaceId),
          ),
        );
      const rows = await tx
        .select({
          commitSha: schema.contextRecords.commitSha,
          publishedAt: schema.contextRecords.publishedAt,
        })
        .from(schema.contextRecords)
        // Same tie-break as `latestPublication`: every publication at the
        // newest instant, stable on id so `commitSha` does not flip between
        // reads.
        .where(
          and(
            published,
            eq(schema.contextRecords.publishedAt, sql`(${newestInstant})`),
          ),
        )
        .orderBy(desc(schema.contextRecords.id));
      return { countRow, rows };
    });
    const newest = rows[0];
    const publication =
      newest?.commitSha && newest.publishedAt
        ? {
            commitSha: newest.commitSha,
            commitShas: [
              ...new Set(
                rows.flatMap((row) =>
                  row.commitSha === null ? [] : [row.commitSha],
                ),
              ),
            ],
            publishedAt: newest.publishedAt,
          }
        : null;
    return { version: countRow?.total ?? 0, publication };
  },

  async insertAppend(values) {
    const existing = () =>
      withTenantDb((tx) =>
        tx
          .select()
          .from(schema.contextAppends)
          .where(
            and(
              eq(schema.contextAppends.workspaceId, values.workspaceId),
              eq(schema.contextAppends.recordHash, values.recordHash),
            ),
          )
          .limit(1),
      );
    try {
      const [row] = await withTenantDb((tx) =>
        tx.insert(schema.contextAppends).values(values).returning(),
      );
      if (!row)
        throw new Error("[context.steering] append insert returned no row");
      return { row, appended: true };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const [row] = await existing();
      if (!row) throw err;
      return { row, appended: false };
    }
  },

  async findAppendByHash(scope, recordHash) {
    const [row] = await withTenantDb((tx) =>
      tx
        .select()
        .from(schema.contextAppends)
        .where(
          and(
            eq(schema.contextAppends.orgId, scope.orgId),
            eq(schema.contextAppends.workspaceId, scope.workspaceId),
            eq(schema.contextAppends.recordHash, recordHash),
          ),
        )
        .limit(1),
    );
    return row ?? null;
  },

  async findAppend(scope, publicId) {
    const [row] = await withTenantDb((tx) =>
      tx
        .select()
        .from(schema.contextAppends)
        .where(
          and(
            eq(schema.contextAppends.orgId, scope.orgId),
            eq(schema.contextAppends.workspaceId, scope.workspaceId),
            eq(schema.contextAppends.publicId, publicId),
          ),
        )
        .limit(1),
    );
    return row ?? null;
  },

  async publishMerge(input) {
    const { scope, proposal } = input;
    return withTenantDb(async (tx) => {
      // Take the lock the INSERT below will take anyway, BEFORE probing.
      //
      // `information_schema` is an ordinary catalog read and locks nothing, so
      // without this the migration's `ALTER TABLE` -- which holds ACCESS
      // EXCLUSIVE -- can commit, and its one-time backfill run, in the window
      // between a `false` answer here and the insert. The insert would then
      // succeed against a migrated table while omitting the four columns from
      // its statement, writing a version that is unclassified for good and that
      // the backfill has already passed by (discussion_r4050518857).
      //
      // ROW EXCLUSIVE is exactly what an INSERT acquires, and it does not
      // conflict with itself, so concurrent merges are unaffected; it conflicts
      // only with the DDL, which is the one thing that must not interleave
      // here. Taking it early moves the acquisition, it does not add one.
      await tx.execute(
        sql`lock table ${schema.contextRecordVersions} in row exclusive mode`,
      );

      // `hasColumnFresh`, not `hasColumn`: a cached MISS must not reach a
      // write. The read path can spend the negative TTL compiling from the
      // record row and be right again on the next call, but a merge that omits
      // the four writes a version that carries NULL for good -- the migration's
      // one-time backfill has already run, and nothing afterwards fills it in.
      // A later merge would then update the record row, and promoting the
      // unclassified version would fall back to that newer row: #3312 again,
      // permanently, for that version (discussion_r4050451667).
      const versionClassificationReady = await hasColumnFresh(
        tx,
        CONTEXT_VERSION_CLASSIFICATION_COLUMN,
        await ambientPlaneKey(),
      );
      const [existing] = await tx
        .select({
          id: schema.contextRecords.id,
          publicId: schema.contextRecords.publicId,
          label: schema.contextRecords.label,
        })
        .from(schema.contextRecords)
        .where(
          and(
            eq(schema.contextRecords.orgId, scope.orgId),
            eq(schema.contextRecords.workspaceId, scope.workspaceId),
            eq(schema.contextRecords.slug, proposal.lineageId),
            isNull(schema.contextRecords.deletedAt),
          ),
        )
        .limit(1);

      const classification = {
        title: proposal.title ?? proposal.statement,
        // An omitted label keeps the record's own. The title names a new
        // record only when the proposal gave no label.
        label:
          proposal.label ??
          existing?.label ??
          proposal.title ??
          contextRecordLabel(proposal.lineageId),
        status: "active" as const,
        kind: proposal.kind,
        force: proposal.force,
        constraintEffect: proposal.constraintEffect,
        sharingScope: proposal.sharingScope,
        statement: proposal.statement,
        commitSha: input.commitSha,
        path: input.path,
        publishedAt: input.mergedAt,
        activatedByUserId: input.mergedByUserId ?? undefined,
        activatedAt: input.mergedAt,
        updatedById: input.mergedByUserId ?? undefined,
        updatedAt: input.mergedAt,
      };

      let recordId: string;
      let recordPublicId: string;
      let version: number;
      let parentVersionId: string | undefined;
      if (existing) {
        recordId = existing.id;
        recordPublicId = existing.publicId;
        const [latest] = await tx
          .select({
            id: schema.contextRecordVersions.id,
            versionNumber: schema.contextRecordVersions.versionNumber,
          })
          .from(schema.contextRecordVersions)
          .where(
            and(
              eq(schema.contextRecordVersions.recordId, recordId),
              eq(schema.contextRecordVersions.isLatest, true),
            ),
          )
          .limit(1);
        if (latest) {
          await tx
            .update(schema.contextRecordVersions)
            .set({ isLatest: false, updatedAt: input.mergedAt })
            .where(eq(schema.contextRecordVersions.id, latest.id));
        }
        version = (latest?.versionNumber ?? 0) + 1;
        parentVersionId = latest?.id;
      } else {
        const [created] = await tx
          .insert(schema.contextRecords)
          .values({
            orgId: scope.orgId,
            workspaceId: scope.workspaceId,
            slug: proposal.lineageId,
            createdById: input.mergedByUserId ?? undefined,
            ...classification,
          })
          .returning({
            id: schema.contextRecords.id,
            publicId: schema.contextRecords.publicId,
          });
        if (!created)
          throw new Error("[context.steering] record insert returned no row");
        recordId = created.id;
        recordPublicId = created.publicId;
        version = 1;
      }

      const [versionRow] = await tx
        .insert(schema.contextRecordVersions)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          recordId,
          versionNumber: version,
          isLatest: true,
          parentVersionId,
          publishedAt: input.mergedAt,
          body: input.body,
          checksum: input.checksum,
          // The version carries what its body says. A later promote of this
          // version copies these four back onto the record row (#3312).
          //
          // Omitted entirely while migration `20260918160000` is pending:
          // naming a column the database does not have raises 42703 and would
          // fail the merge outright. The record row still gets them, so the
          // merge is not lossy, and the version reads through
          // `classificationOf`'s record-row fallback until the migration lands.
          ...(versionClassificationReady
            ? {
                kind: proposal.kind,
                force: proposal.force,
                constraintEffect: proposal.constraintEffect,
                statement: proposal.statement,
              }
            : {}),
          provenance: [
            {
              type: "commit",
              uri: `${proposal.repository ?? ""}@${input.commitSha}:${input.path}`,
              digest: input.checksum,
              method: "context_pr",
              by: proposal.publicId,
            },
          ],
          createdById: input.mergedByUserId ?? undefined,
          updatedById: input.mergedByUserId ?? undefined,
        })
        .returning({ id: schema.contextRecordVersions.id });
      if (!versionRow)
        throw new Error("[context.steering] version insert returned no row");

      await tx
        .update(schema.contextRecords)
        .set({ ...classification, activeVersionId: versionRow.id })
        .where(eq(schema.contextRecords.id, recordId));

      // The promotion event: the next link in the record's chain, and one more
      // entry in the workspace ledger (its steering version).
      const [ledger] = await tx
        .select({ total: count() })
        .from(schema.contextPromotions)
        .where(
          and(
            eq(schema.contextPromotions.orgId, scope.orgId),
            eq(schema.contextPromotions.workspaceId, scope.workspaceId),
          ),
        );
      const ledgerBefore = ledger?.total ?? 0;
      const [head] = await tx
        .select({
          seq: schema.contextPromotions.seq,
          chainDigest: schema.contextPromotions.chainDigest,
        })
        .from(schema.contextPromotions)
        .where(eq(schema.contextPromotions.recordId, recordId))
        .orderBy(desc(schema.contextPromotions.seq))
        .limit(1);
      const seq = (head?.seq ?? 0) + 1;
      const prevChainDigest = head?.chainDigest ?? null;
      const chainDigest = sha256Hex(
        (prevChainDigest ?? "") +
          canonicalJson({
            action: "promote",
            approver_user_id: input.mergedByUserId,
            policy_version: input.policyVersion,
            record_id: recordId,
            seq,
            version_id: versionRow.id,
          }),
      );
      const [promotion] = await tx
        .insert(schema.contextPromotions)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          recordId,
          versionId: versionRow.id,
          seq,
          action: "promote",
          approverUserId: input.mergedByUserId,
          policyVersion: input.policyVersion,
          prevChainDigest,
          chainDigest,
          createdById: input.mergedByUserId ?? undefined,
        })
        .returning({
          id: schema.contextPromotions.id,
          publicId: schema.contextPromotions.publicId,
        });
      if (!promotion)
        throw new Error("[context.steering] promotion insert returned no row");

      // The transition is the transaction's guard: two calls that both read
      // `checks_passed` and both reached here publish once, the second one
      // rolling back its record, version and ledger row.
      const [transitioned] = await tx
        .update(schema.contextProposals)
        .set({
          status: "merged",
          mergedCommit: input.commitSha,
          mergedAt: input.mergedAt,
          mergedByUserId: input.mergedByUserId,
          publishedRecordId: recordId,
          promotionEventId: promotion.id,
          updatedById: input.mergedByUserId ?? undefined,
          updatedAt: input.mergedAt,
        })
        .where(
          and(
            eq(schema.contextProposals.id, proposal.id),
            eq(schema.contextProposals.status, "checks_passed"),
          ),
        )
        .returning({ id: schema.contextProposals.id });
      if (!transitioned) throw alreadyMerged(proposal.publicId);

      return {
        recordId,
        recordPublicId,
        versionId: versionRow.id,
        version,
        promotion: {
          id: promotion.id,
          publicId: promotion.publicId,
          seq,
          chainDigest,
        },
        ledgerBefore,
      };
    });
  },
};
