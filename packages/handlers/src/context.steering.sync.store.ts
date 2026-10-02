// context.steering.sync.store.ts: the Postgres side of the repository sync
// (ADR-184). The per-workspace sync state, and the one transaction that reads
// the registry, plans against it and writes the plan under the workspace's
// publication lock, so a merge from Oxagen and a sync never interleave.
import {
  ambientPlaneKey,
  STEERING_VERSION_CLASSIFICATION_COLUMN,
  hasColumnFresh,
  schema,
  withTenantDb,
} from "@oxagen/database";
import { steeringRecordLabel } from "@oxagen/oxagen/steering-record-label";
import { recordKindSchema } from "@oxagen/oxagen/contracts/context.steering.shared";
import {
  EMBEDDINGS_SETTING,
  STELLA_ARCHIVE_AFTER_DAYS_SETTING,
  type EmbeddingsSetting,
} from "@oxagen/oxagen/steering-repo/workspace";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
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

/** The settings a sync publishes from workspace.toml into the workspace row. */
export interface PublishedWorkspaceSettings {
  /** `[stella] archive_after_days`, or null when the file sets none. */
  stellaArchiveAfterDays: number | null;
  /** `[embeddings]`, or null when the file sets none (ADR-217). */
  embeddings: EmbeddingsSetting | null;
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
  /** Every proposal whose steering PR is open in Oxagen's view. */
  openProposals(scope: Scope): Promise<ProposalRow[]>;
  /**
   * Record a steering PR the host merged: the proposal points at its lineage's
   * record and newest promotion. False when the lineage has no active record,
   * the proposal already left the open states, or a merge claimed it after
   * `noClaimSince` and is still landing it (#4504).
   */
  linkMergedProposal(
    scope: Scope,
    proposalId: string,
    args: {
      lineageId: string;
      mergedCommit: string;
      mergedAt: Date;
      noClaimSince: Date;
    },
  ): Promise<boolean>;
  /**
   * Record a governance or steering PR the host merged (#4795, #5122). Such
   * a proposal publishes no single record, so it points at none: the row
   * moves to `merged` with its merge commit and no approver. False when the
   * row is a record proposal, already left the open states, or a merge
   * claimed it after `noClaimSince` and is still landing it.
   */
  linkMergedWithoutRecord(
    scope: Scope,
    proposalId: string,
    args: { mergedCommit: string; mergedAt: Date; noClaimSince: Date },
  ): Promise<boolean>;
  /**
   * True when a governance proposal Oxagen merged names `commitSha` as its
   * merge commit: merge_steering_pr landed it for an approver (#4795).
   */
  governanceMergedAt(scope: Scope, commitSha: string): Promise<boolean>;
  /**
   * Write the settings workspace.toml sets into `workspaces.settings`. A null
   * value removes its key, so the reader falls back to its default.
   */
  publishWorkspaceSettings(
    scope: Scope,
    settings: PublishedWorkspaceSettings,
  ): Promise<void>;
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
        sql`lock table ${schema.steeringRecordVersions} in row exclusive mode`,
      );
      const classificationReady = await hasColumnFresh(
        tx,
        STEERING_VERSION_CLASSIFICATION_COLUMN,
        await ambientPlaneKey(),
      );
      const rows = await tx
        .select({
          id: schema.steeringRecords.id,
          slug: schema.steeringRecords.slug,
          path: schema.steeringRecords.path,
          status: schema.steeringRecords.status,
          deletedAt: schema.steeringRecords.deletedAt,
          title: schema.steeringRecords.title,
          label: schema.steeringRecords.label,
          kind: schema.steeringRecords.kind,
          constraintEffect: schema.steeringRecords.constraintEffect,
          statement: schema.steeringRecords.statement,
          body: schema.steeringRecordVersions.body,
        })
        .from(schema.steeringRecords)
        .leftJoin(
          schema.steeringRecordVersions,
          eq(
            schema.steeringRecordVersions.id,
            schema.steeringRecords.activeVersionId,
          ),
        )
        .where(scoped(schema.steeringRecords, scope));
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
        .select({ at: max(schema.steeringRecords.publishedAt) })
        .from(schema.steeringRecords)
        .where(
          and(
            scoped(schema.steeringRecords, scope),
            isNotNull(schema.steeringRecords.commitSha),
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
            p.content.label ?? before?.label ?? steeringRecordLabel(p.lineageId),
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
            .insert(schema.steeringRecords)
            .values({ ...scope, ...fields })
            .returning({ id: schema.steeringRecords.id });
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
          .update(schema.steeringRecords)
          .set({ ...fields, activeVersionId: version.id })
          .where(eq(schema.steeringRecords.id, recordId));
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
          .update(schema.steeringRecords)
          .set({
            ...(u.slug !== undefined ? { slug: u.slug } : {}),
            ...(u.path !== undefined ? { path: u.path } : {}),
            ...(u.label !== undefined ? { label: u.label } : {}),
            updatedAt: input.now,
          })
          .where(eq(schema.steeringRecords.id, u.recordId));
      }

      for (const r of plan.retire) {
        // A retirement is a publication too: a checkout that still holds the
        // file is behind, so the freshness read must name this commit.
        await tx
          .update(schema.steeringRecords)
          .set({
            status: "retired",
            commitSha: input.commitSha,
            publishedAt,
            updatedAt: input.now,
          })
          .where(eq(schema.steeringRecords.id, r.recordId));
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
        .from(schema.steeringProposals)
        .where(
          and(
            scoped(schema.steeringProposals, scope),
            inArray(schema.steeringProposals.status, [...OPEN_PR]),
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
        .select({ id: schema.steeringRecords.id })
        .from(schema.steeringRecords)
        .where(
          and(
            scoped(schema.steeringRecords, scope),
            eq(schema.steeringRecords.slug, args.lineageId),
            eq(schema.steeringRecords.status, "active"),
            sql`${schema.steeringRecords.deletedAt} is null`,
          ),
        )
        .limit(1);
      if (!record) return false;
      const [promotion] = await tx
        .select({ id: schema.steeringPromotions.id })
        .from(schema.steeringPromotions)
        .where(
          and(
            eq(schema.steeringPromotions.recordId, record.id),
            eq(schema.steeringPromotions.action, "promote"),
          ),
        )
        .orderBy(desc(schema.steeringPromotions.seq))
        .limit(1);
      if (!promotion) return false;
      const [row] = await tx
        .update(schema.steeringProposals)
        .set({
          status: "merged",
          mergedCommit: args.mergedCommit,
          mergedAt: args.mergedAt,
          mergedByUserId: null,
          publishedRecordId: record.id,
          promotionEventId: promotion.id,
          mergeClaimedAt: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.steeringProposals.id, proposalId),
            inArray(schema.steeringProposals.status, [...OPEN_PR]),
            or(
              isNull(schema.steeringProposals.mergeClaimedAt),
              lte(schema.steeringProposals.mergeClaimedAt, args.noClaimSince),
            ),
          ),
        )
        .returning({ id: schema.steeringProposals.id });
      return row !== undefined;
    });
  },

  async linkMergedWithoutRecord(scope, proposalId, args) {
    return withTenantDb(async (tx) => {
      await lockWorkspacePublication(tx, scope.workspaceId);
      const [row] = await tx
        .update(schema.steeringProposals)
        .set({
          status: "merged",
          mergedCommit: args.mergedCommit,
          mergedAt: args.mergedAt,
          mergedByUserId: null,
          mergeClaimedAt: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(schema.steeringProposals.id, proposalId),
            scoped(schema.steeringProposals, scope),
            notInArray(schema.steeringProposals.kind, [...recordKindSchema.options]),
            inArray(schema.steeringProposals.status, [...OPEN_PR]),
            or(
              isNull(schema.steeringProposals.mergeClaimedAt),
              lte(schema.steeringProposals.mergeClaimedAt, args.noClaimSince),
            ),
          ),
        )
        .returning({ id: schema.steeringProposals.id });
      return row !== undefined;
    });
  },

  async governanceMergedAt(scope, commitSha) {
    const [row] = await withTenantDb((tx) =>
      tx
        .select({ id: schema.steeringProposals.id })
        .from(schema.steeringProposals)
        .where(
          and(
            scoped(schema.steeringProposals, scope),
            eq(schema.steeringProposals.kind, "governance"),
            eq(schema.steeringProposals.status, "merged"),
            eq(schema.steeringProposals.mergedCommit, commitSha),
            isNotNull(schema.steeringProposals.mergedByUserId),
          ),
        )
        .limit(1),
    );
    return row !== undefined;
  },

  async publishWorkspaceSettings(scope, settings) {
    const column = schema.workspaces.settings;
    // The bag holds keys other writers own, so this merges each key in or
    // takes it out. A bag that is not an object becomes one, as it does in
    // `workspace.settings.write`. The WHERE clause skips a row that already
    // holds every value, so a sync with nothing new writes nothing.
    let next: SQL = sql`CASE WHEN jsonb_typeof(${column}) = 'object' THEN ${column} ELSE '{}'::jsonb END`;
    const changed: SQL[] = [];
    const values: ReadonlyArray<[key: string, value: unknown]> = [
      [STELLA_ARCHIVE_AFTER_DAYS_SETTING, settings.stellaArchiveAfterDays],
      [EMBEDDINGS_SETTING, settings.embeddings],
    ];
    for (const [key, value] of values) {
      if (value === null) {
        next = sql`(${next}) - ${key}::text`;
        changed.push(sql`${column} -> ${key}::text is not null`);
      } else {
        const json = JSON.stringify(value);
        next = sql`(${next}) || jsonb_build_object(${key}::text, ${json}::jsonb)`;
        changed.push(sql`${column} -> ${key}::text is distinct from ${json}::jsonb`);
      }
    }
    await withTenantDb((tx) =>
      tx
        .update(schema.workspaces)
        .set({ settings: next, updatedAt: new Date() })
        .where(
          and(
            eq(schema.workspaces.id, scope.workspaceId),
            eq(schema.workspaces.orgId, scope.orgId),
            or(...changed),
          ),
        ),
    );
  },
};
