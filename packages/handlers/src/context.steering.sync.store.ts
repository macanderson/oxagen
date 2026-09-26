// context.steering.sync.store.ts: the Postgres side of the repository sync
// (ADR-184). The per-workspace sync state, and the one transaction that reads
// the registry, plans against it and writes the plan under the workspace's
// publication lock, so a merge from Oxagen and a sync never interleave.
import {
  ambientPlaneKey,
  CONTEXT_VERSION_CLASSIFICATION_COLUMN,
  hasColumnFresh,
  schema,
  withTenantDb,
} from "@oxagen/database";
import { contextRecordLabel } from "@oxagen/oxagen/context-record-label";
import { and, desc, eq, inArray, isNotNull, max, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  appendPromotion,
  appendVersion,
  lockWorkspacePublication,
} from "./context.steering.publication";
import type { ProposalRow } from "./context.steering.store";
import type {
  RegistryRecord,
  SyncFinding,
  SyncPlan,
} from "./context.steering.sync.plan";

interface Scope {
  orgId: string;
  workspaceId: string;
}

export type SyncStatus = "pending" | "synced" | "problems" | "failed";

export interface SyncState {
  provider: string | null;
  repository: string | null;
  branch: string | null;
  /** The production-branch commit the registry last matched. */
  headSha: string | null;
  /** The newest commit at that head that changed `.oxagen/rules/`. */
  rulesSha: string | null;
  status: SyncStatus;
  findings: SyncFinding[];
  error: string | null;
  /** When a push or merge last asked for a sync. */
  requestedAt: Date | null;
  /** When a sync last finished, cleanly or not. */
  syncedAt: Date | null;
}

export type SyncStateWrite = Omit<SyncState, "requestedAt">;

/** What the sync publishes with, beyond the plan. */
export interface ApplyInput {
  /** The commit that last changed the rules directory at the synced head. */
  commitSha: string;
  /** That commit's instant; clamped so it never sorts before an earlier publication. */
  publishedAt: Date;
  /** `owner/name` as the binding approved it. */
  repository: string;
  /** Who made that commit, as the host names them; provenance, not identity. */
  authoredBy: string | null;
  now: Date;
}

export interface AppliedSync {
  plan: SyncPlan;
  created: number;
  revised: number;
  updated: number;
  retired: number;
}

export interface SyncStore {
  readState(scope: Scope): Promise<SyncState | null>;
  /** Stamp `requested_at`, creating the row on the first request. */
  markRequested(scope: Scope, at: Date): Promise<void>;
  writeState(scope: Scope, state: SyncStateWrite): Promise<void>;
  /**
   * Read the registry, plan against it, and write the plan, in one
   * transaction under the workspace's publication lock.
   */
  apply(
    scope: Scope,
    input: ApplyInput,
    plan: (records: RegistryRecord[]) => SyncPlan,
  ): Promise<AppliedSync>;
  /** Every proposal whose Context PR is open in Oxagen's view. */
  openProposals(scope: Scope): Promise<ProposalRow[]>;
  /**
   * Record a Context PR the host merged: the proposal points at its lineage's
   * record and newest promotion. False when the lineage has no active record
   * or the proposal already left the open states.
   */
  linkMergedProposal(
    scope: Scope,
    proposalId: string,
    args: { lineageId: string; mergedCommit: string; mergedAt: Date },
  ): Promise<boolean>;
}

/** The ledger's policy version for a publication the repository made. */
export const SYNC_POLICY_VERSION = "repository:sync";

const OPEN_PR = [
  "pr_open",
  "checks_running",
  "checks_passed",
  "checks_failed",
] as const;

/** Every table this store reads carries the org and workspace columns. */
const scoped = (
  table: { orgId: PgColumn; workspaceId: PgColumn },
  scope: Scope,
) =>
  and(eq(table.orgId, scope.orgId), eq(table.workspaceId, scope.workspaceId));

function toState(row: typeof schema.contextSyncState.$inferSelect): SyncState {
  return {
    provider: row.provider,
    repository: row.repository,
    branch: row.branch,
    headSha: row.headSha,
    rulesSha: row.rulesSha,
    status: row.status as SyncStatus,
    findings: Array.isArray(row.findings)
      ? (row.findings as SyncFinding[])
      : [],
    error: row.error,
    requestedAt: row.requestedAt,
    syncedAt: row.syncedAt,
  };
}

export const postgresSyncStore: SyncStore = {
  async readState(scope) {
    const [row] = await withTenantDb((tx) =>
      tx
        .select()
        .from(schema.contextSyncState)
        .where(scoped(schema.contextSyncState, scope))
        .limit(1),
    );
    return row ? toState(row) : null;
  },

  async markRequested(scope, at) {
    await withTenantDb((tx) =>
      tx
        .insert(schema.contextSyncState)
        .values({ ...scope, requestedAt: at, updatedAt: at })
        .onConflictDoUpdate({
          target: [
            schema.contextSyncState.orgId,
            schema.contextSyncState.workspaceId,
          ],
          set: { requestedAt: at, updatedAt: at },
        }),
    );
  },

  async writeState(scope, state) {
    const values = {
      provider: state.provider,
      repository: state.repository,
      branch: state.branch,
      headSha: state.headSha,
      rulesSha: state.rulesSha,
      status: state.status,
      findings: state.findings,
      error: state.error,
      syncedAt: state.syncedAt,
      updatedAt: state.syncedAt ?? new Date(),
    };
    await withTenantDb((tx) =>
      tx
        .insert(schema.contextSyncState)
        .values({ ...scope, ...values })
        .onConflictDoUpdate({
          target: [
            schema.contextSyncState.orgId,
            schema.contextSyncState.workspaceId,
          ],
          set: values,
        }),
    );
  },

  async apply(scope, input, planFor) {
    return withTenantDb(async (tx) => {
      await lockWorkspacePublication(tx, scope.workspaceId);
      // The same early table lock `publishMerge` takes, for the same reason:
      // the classification probe below must not race the migration's DDL.
      await tx.execute(
        sql`lock table ${schema.contextRecordVersions} in row exclusive mode`,
      );
      const classificationReady = await hasColumnFresh(
        tx,
        CONTEXT_VERSION_CLASSIFICATION_COLUMN,
        await ambientPlaneKey(),
      );
      const rows = await tx
        .select({
          id: schema.contextRecords.id,
          slug: schema.contextRecords.slug,
          path: schema.contextRecords.path,
          status: schema.contextRecords.status,
          deletedAt: schema.contextRecords.deletedAt,
          title: schema.contextRecords.title,
          label: schema.contextRecords.label,
          kind: schema.contextRecords.kind,
          constraintEffect: schema.contextRecords.constraintEffect,
          statement: schema.contextRecords.statement,
          body: schema.contextRecordVersions.body,
        })
        .from(schema.contextRecords)
        .leftJoin(
          schema.contextRecordVersions,
          eq(
            schema.contextRecordVersions.id,
            schema.contextRecords.activeVersionId,
          ),
        )
        .where(scoped(schema.contextRecords, scope));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const plan = planFor(
        rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          path: r.path,
          status: r.status,
          deleted: r.deletedAt !== null,
          label: r.label,
          kind: r.kind,
          constraintEffect: r.constraintEffect,
          statement: r.statement,
          body: r.body,
        })),
      );
      if (plan.publish.length + plan.update.length + plan.retire.length === 0)
        return { plan, created: 0, revised: 0, updated: 0, retired: 0 };

      // Stamped with the commit's instant, but never before the newest
      // publication already here: this commit descends from every one of
      // them, and an earlier stamp would make `latestPublication` name an
      // ancestor as the commit a checkout must reach. A tie is safe, because
      // the freshness read requires every commit at the newest instant.
      const [newest] = await tx
        .select({ at: max(schema.contextRecords.publishedAt) })
        .from(schema.contextRecords)
        .where(
          and(
            scoped(schema.contextRecords, scope),
            isNotNull(schema.contextRecords.commitSha),
          ),
        );
      const publishedAt =
        newest?.at && newest.at > input.publishedAt
          ? newest.at
          : input.publishedAt;

      let created = 0;
      let revised = 0;
      for (const p of plan.publish) {
        const before = p.recordId ? byId.get(p.recordId) : undefined;
        const fields = {
          slug: p.lineageId,
          // The record's name when the file gives none: its own, then one
          // derived from the lineage (ADR-178).
          label:
            p.content.label ?? before?.label ?? contextRecordLabel(p.lineageId),
          // A title that was the old statement follows the new one; a title a
          // proposal wrote stays.
          title:
            !before || before.title === before.statement
              ? p.content.statement
              : before.title,
          status: "active",
          kind: p.content.kind,
          force: p.content.force,
          constraintEffect: p.content.constraintEffect,
          sharingScope: p.content.sharingScope,
          statement: p.content.statement,
          commitSha: input.commitSha,
          path: p.path,
          publishedAt,
          activatedAt: publishedAt,
          activatedByUserId: null,
          deletedAt: null,
          updatedAt: input.now,
        };
        let recordId = p.recordId;
        if (!recordId) {
          const [row] = await tx
            .insert(schema.contextRecords)
            .values({ ...scope, ...fields })
            .returning({ id: schema.contextRecords.id });
          if (!row)
            throw new Error("[context.sync] record insert returned no row");
          recordId = row.id;
          created += 1;
        } else revised += 1;
        const version = await appendVersion(tx, {
          scope,
          recordId,
          body: p.body,
          checksum: p.checksum,
          publishedAt,
          classification: {
            kind: p.content.kind,
            force: p.content.force,
            constraintEffect: p.content.constraintEffect,
            statement: p.content.statement,
          },
          classificationReady,
          provenance: [
            {
              type: "commit",
              uri: `${input.repository}@${input.commitSha}:${p.path}`,
              digest: p.checksum,
              method: "repository_sync",
              by: input.authoredBy,
            },
          ],
          byUserId: null,
        });
        await tx
          .update(schema.contextRecords)
          .set({ ...fields, activeVersionId: version.id })
          .where(eq(schema.contextRecords.id, recordId));
        await appendPromotion(tx, {
          scope,
          recordId,
          versionId: version.id,
          action: "promote",
          approverUserId: null,
          policyVersion: SYNC_POLICY_VERSION,
        });
      }

      for (const u of plan.update) {
        await tx
          .update(schema.contextRecords)
          .set({
            ...(u.slug !== undefined ? { slug: u.slug } : {}),
            ...(u.path !== undefined ? { path: u.path } : {}),
            ...(u.label !== undefined ? { label: u.label } : {}),
            updatedAt: input.now,
          })
          .where(eq(schema.contextRecords.id, u.recordId));
      }

      for (const r of plan.retire) {
        // A retirement is a publication too: a checkout that still holds the
        // file is behind, so the freshness read must name this commit.
        await tx
          .update(schema.contextRecords)
          .set({
            status: "retired",
            commitSha: input.commitSha,
            publishedAt,
            updatedAt: input.now,
          })
          .where(eq(schema.contextRecords.id, r.recordId));
        await appendPromotion(tx, {
          scope,
          recordId: r.recordId,
          versionId: null,
          action: "retire",
          approverUserId: null,
          policyVersion: SYNC_POLICY_VERSION,
        });
      }

      return {
        plan,
        created,
        revised,
        updated: plan.update.length,
        retired: plan.retire.length,
      };
    });
  },

  async openProposals(scope) {
    const rows = await withTenantDb((tx) =>
      tx
        .select()
        .from(schema.contextProposals)
        .where(
          and(
            scoped(schema.contextProposals, scope),
            inArray(schema.contextProposals.status, [...OPEN_PR]),
          ),
        ),
    );
    return rows.map((row) => ({
      ...row,
      checks: Array.isArray(row.checks)
        ? (row.checks as ProposalRow["checks"])
        : [],
    }));
  },

  async linkMergedProposal(scope, proposalId, args) {
    return withTenantDb(async (tx) => {
      await lockWorkspacePublication(tx, scope.workspaceId);
      const [record] = await tx
        .select({ id: schema.contextRecords.id })
        .from(schema.contextRecords)
        .where(
          and(
            scoped(schema.contextRecords, scope),
            eq(schema.contextRecords.slug, args.lineageId),
            eq(schema.contextRecords.status, "active"),
            sql`${schema.contextRecords.deletedAt} is null`,
          ),
        )
        .limit(1);
      if (!record) return false;
      const [promotion] = await tx
        .select({ id: schema.contextPromotions.id })
        .from(schema.contextPromotions)
        .where(
          and(
            eq(schema.contextPromotions.recordId, record.id),
            eq(schema.contextPromotions.action, "promote"),
          ),
        )
        .orderBy(desc(schema.contextPromotions.seq))
        .limit(1);
      if (!promotion) return false;
      const [row] = await tx
        .update(schema.contextProposals)
        .set({
          status: "merged",
          mergedCommit: args.mergedCommit,
          mergedAt: args.mergedAt,
          mergedByUserId: null,
          publishedRecordId: record.id,
          promotionEventId: promotion.id,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.contextProposals.id, proposalId),
            inArray(schema.contextProposals.status, [...OPEN_PR]),
          ),
        )
        .returning({ id: schema.contextProposals.id });
      return row !== undefined;
    });
  },
};
