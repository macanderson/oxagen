import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { contextRecordPublish } from "@oxagen/oxagen/contracts/context.record.publish";
import {
  ambientPlaneKey,
  CONTEXT_VERSION_CLASSIFICATION_COLUMN,
  hasColumnFresh,
  schema,
  withTenantDb,
  isUniqueViolation,
} from "@oxagen/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import { assertWorkspaceNotProvisional } from "./lib/onboarding";
import { logger } from "./logger";
import { sha256Hex } from "./registry-digest";

/**
 * Publish one steering context record into the workspace agent-asset
 * registry — the platform mirror of adding a .stella/rules/<record_id>.toml
 * file. Upserts agent.context_records by (workspace, record_id) and creates
 * a new immutable version row only when the version content changed: the
 * body checksum or any of kind, force, constraintEffect, statement. A publish
 * that repeats all of them is idempotent (published: false). Same shape as
 * tool.declaration.publish.
 *
 * Writes the caller's classification (kind, force, constraintEffect,
 * statement) onto both the record row and the version row, mirroring
 * `publishMerge` (context.steering.store.ts). Before #3302 this handler wrote
 * only the body, leaving all four NULL: `readWorkspaceSteering` only ever
 * delivers a record whose force is `must` or `should`, so a record published
 * this way sat active in the registry and never reached an agent.
 */
export const contextRecordPublishHandler: CapabilityHandler<
  typeof contextRecordPublish
> = async (input, ctx) => {
  await assertOrgRole(
    { ...ctx, userId: await resolveActingUserId(ctx) },
    { org: ["Owner", "Admin"], workspace: ["Owner", "Admin"] },
  );

  if (!ctx.workspaceId) {
    throw new Error(
      "[context.record.publish] workspaceId is required (scoped capability)",
    );
  }

  const slug = input.record_id.trim().toLowerCase();
  const checksum = sha256Hex(input.body);
  const provenance = input.provenance ?? [];

  const orgId = ctx.orgId;
  const workspaceId = ctx.workspaceId;

  // A provisional workspace has no main repository to publish to (#2967).
  await assertWorkspaceNotProvisional({ orgId, workspaceId });

  const findExisting = async () => {
    const rows = await withTenantDb((tx) =>
      tx
        .select({
          id: schema.contextRecords.id,
          publicId: schema.contextRecords.publicId,
          slug: schema.contextRecords.slug,
        })
        .from(schema.contextRecords)
        .where(
          and(
            eq(schema.contextRecords.orgId, orgId),
            eq(schema.contextRecords.workspaceId, workspaceId),
            eq(schema.contextRecords.slug, slug),
            isNull(schema.contextRecords.deletedAt),
          ),
        )
        .limit(1),
    );
    return rows[0] ?? null;
  };

  // The classification a caller must now supply (#3302): a record with no
  // force never reaches `readWorkspaceSteering`'s must/should filter, so a
  // record published without one sat in the registry and never steered
  // anything. Written onto both the version (what this body says) and the
  // record row (what `list_records`, `listActiveRecords` and the steering
  // page filter and display), the same split `merge_context_pr` keeps.
  const classification = {
    kind: input.kind,
    force: input.force,
    constraintEffect: input.constraintEffect ?? null,
    statement: input.statement,
  };

  const versionValuesBase = {
    orgId,
    workspaceId,
    body: input.body,
    checksum,
    provenance,
    isLatest: true,
    publishedAt: sql`now()`,
    createdById: ctx.userId ?? undefined,
    updatedById: ctx.userId ?? undefined,
  };

  // Codex P1 on #3486: `context_record_versions.kind/force/constraintEffect/
  // statement` were added by migration `20260918160000`, which -- like every
  // Postgres migration in this repo -- is applied by the manual
  // `db-migrate.yml` workflow, never automatically alongside a deploy
  // (`pipeline.yml`'s `deploy-node` runs right after `test`, with no
  // ordering against a migration run). A deployment can therefore run this
  // handler's code before that migration has been applied, and an
  // unconditional SELECT/INSERT naming those columns fails every publish
  // with Postgres 42703 in that window. `publishMerge`
  // (`context.steering.store.ts`) and `context.record.promote.ts` already
  // guard the exact same columns with `hasColumnFresh` +
  // `CONTEXT_VERSION_CLASSIFICATION_COLUMN`; this handler follows the same
  // pattern rather than inventing a second one.

  // Version-publish path against an existing record row: idempotent when the
  // latest version already carries this checksum AND this classification,
  // otherwise latest+1. The checksum alone is not the key: a record backfilled
  // to memory/info (or one whose classification was wrong) is corrected by
  // republishing the unchanged body with the right kind/force, and that
  // correction must land as a new version or the record never reaches
  // `readWorkspaceSteering`.
  const publishVersionFor = async (existing: {
    id: string;
    publicId: string;
    slug: string;
  }) => {
    const { latest, readAtLookup } = await withTenantDb(async (tx) => {
      // ACCESS SHARE, same as context.record.promote.ts's read of these
      // columns: information_schema locks nothing on its own, so without
      // this the migration's ALTER TABLE (ACCESS EXCLUSIVE) could commit
      // between a `false` readiness answer and this SELECT reading a
      // column that no longer -- or not yet -- matches that answer.
      await tx.execute(
        sql`lock table ${schema.contextRecordVersions} in access share mode`,
      );
      const ready = await hasColumnFresh(
        tx,
        CONTEXT_VERSION_CLASSIFICATION_COLUMN,
        await ambientPlaneKey(),
      );
      // Two concrete `.select()` calls rather than one with a ternary column
      // object: drizzle cannot narrow a select() argument chosen at runtime
      // into one clean row type, and the resulting `{}` fields broke every
      // downstream read of `latest.id` / `latest.versionNumber`. Each branch
      // is typed on its own, then normalized to one shape below.
      if (ready) {
        const [full] = await tx
          .select({
            id: schema.contextRecordVersions.id,
            versionNumber: schema.contextRecordVersions.versionNumber,
            checksum: schema.contextRecordVersions.checksum,
            kind: schema.contextRecordVersions.kind,
            force: schema.contextRecordVersions.force,
            constraintEffect: schema.contextRecordVersions.constraintEffect,
            statement: schema.contextRecordVersions.statement,
          })
          .from(schema.contextRecordVersions)
          .where(
            and(
              eq(schema.contextRecordVersions.recordId, existing.id),
              eq(schema.contextRecordVersions.isLatest, true),
            ),
          )
          .limit(1);
        return { latest: full, readAtLookup: ready };
      }
      const [partial] = await tx
        .select({
          id: schema.contextRecordVersions.id,
          versionNumber: schema.contextRecordVersions.versionNumber,
          checksum: schema.contextRecordVersions.checksum,
        })
        .from(schema.contextRecordVersions)
        .where(
          and(
            eq(schema.contextRecordVersions.recordId, existing.id),
            eq(schema.contextRecordVersions.isLatest, true),
          ),
        )
        .limit(1);
      const latest = partial
        ? {
            ...partial,
            kind: null,
            force: null,
            constraintEffect: null,
            statement: null,
          }
        : undefined;
      return { latest, readAtLookup: ready };
    });

    // Codex P1 on #3486 (round 3): before the migration lands, this handler
    // cannot compare a classification the version row has no columns for.
    // Treating that as "unchanged" (the earlier, checksum-only fallback)
    // let a genuine correction -- an unchanged body republished under a
    // fixed kind/force -- return published: false without ever updating the
    // record row, silently discarding the correction for the rest of the
    // compatibility window. Unreadable therefore means CHANGED: this always
    // takes the publish-new-version path below, which updates the record
    // row's classification unconditionally (those columns predate the
    // migration and always exist) even though the version row itself is
    // written without the four columns until the migration lands.
    const unchanged =
      latest !== undefined &&
      latest.checksum === checksum &&
      readAtLookup &&
      "kind" in latest &&
      latest.kind === classification.kind &&
      latest.force === classification.force &&
      (latest.constraintEffect ?? null) === classification.constraintEffect &&
      (latest.statement ?? null) === classification.statement;

    if (latest && unchanged) {
      logger.info(
        { slug, publicId: existing.publicId, workspaceId },
        "context.record.publish: idempotent — body and classification unchanged",
      );
      return {
        publicId: existing.publicId,
        recordId: existing.slug,
        version: latest.versionNumber,
        checksum,
        published: false,
      };
    }

    const nextVersion = (latest?.versionNumber ?? 0) + 1;
    await withTenantDb(async (tx) => {
      if (latest) {
        await tx
          .update(schema.contextRecordVersions)
          .set({ isLatest: false, updatedAt: sql`now()` })
          .where(eq(schema.contextRecordVersions.id, latest.id));
      }
      // ROW EXCLUSIVE, same as publishMerge: this is what the INSERT below
      // acquires anyway, and taking it before the readiness probe closes the
      // same window -- the migration's ALTER TABLE committing between a
      // `false` answer and a write that would otherwise name the four
      // columns regardless.
      await tx.execute(
        sql`lock table ${schema.contextRecordVersions} in row exclusive mode`,
      );
      const ready = await hasColumnFresh(
        tx,
        CONTEXT_VERSION_CLASSIFICATION_COLUMN,
        await ambientPlaneKey(),
      );
      const [versionRow] = await tx
        .insert(schema.contextRecordVersions)
        .values({
          ...versionValuesBase,
          ...(ready ? classification : {}),
          recordId: existing.id,
          versionNumber: nextVersion,
          parentVersionId: latest?.id ?? undefined,
        })
        .returning({ id: schema.contextRecordVersions.id });
      if (!versionRow) {
        throw new Error(
          "[context.record.publish] Version insert returned no row.",
        );
      }
      await tx
        .update(schema.contextRecords)
        .set({
          title: input.title,
          activeVersionId: versionRow.id,
          activatedByUserId: ctx.userId ?? undefined,
          activatedAt: sql`now()`,
          ...classification,
          updatedById: ctx.userId ?? undefined,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.contextRecords.id, existing.id));
    });

    logger.info(
      { slug, publicId: existing.publicId, version: nextVersion, workspaceId },
      "context.record.publish: published new version",
    );
    return {
      publicId: existing.publicId,
      recordId: existing.slug,
      version: nextVersion,
      checksum,
      published: true,
    };
  };

  const existing = await findExisting();
  if (existing) {
    return publishVersionFor(existing);
  }

  // Fresh record: identity row + version 1 in one transaction. Two concurrent
  // publishes can both pass the existence check; the workspace-slug unique
  // index throws 23505 for the loser and we fall back to the version path.
  try {
    const result = await withTenantDb(async (tx) => {
      const [recordRow] = await tx
        .insert(schema.contextRecords)
        .values({
          orgId,
          workspaceId,
          slug,
          title: input.title,
          status: "active",
          ...classification,
          createdById: ctx.userId ?? undefined,
          updatedById: ctx.userId ?? undefined,
        })
        .returning({
          id: schema.contextRecords.id,
          publicId: schema.contextRecords.publicId,
          slug: schema.contextRecords.slug,
        });
      if (!recordRow) {
        throw new Error(
          "[context.record.publish] Record insert returned no row.",
        );
      }
      // Codex P1 on #3486 (round 5): same ROW EXCLUSIVE lock as the
      // existing-record path takes before its probe, and for the same
      // reason. Without it, migration 20260918160000's ACCESS EXCLUSIVE
      // ALTER TABLE can commit between a `false` answer and this INSERT,
      // permanently leaving a fresh version unclassified even though the
      // columns and their backfill finished before the insert lands.
      await tx.execute(
        sql`lock table ${schema.contextRecordVersions} in row exclusive mode`,
      );
      const versionReady = await hasColumnFresh(
        tx,
        CONTEXT_VERSION_CLASSIFICATION_COLUMN,
        await ambientPlaneKey(),
      );
      const [versionRow] = await tx
        .insert(schema.contextRecordVersions)
        .values({
          ...versionValuesBase,
          ...(versionReady ? classification : {}),
          recordId: recordRow.id,
          versionNumber: 1,
        })
        .returning({ id: schema.contextRecordVersions.id });
      if (!versionRow) {
        throw new Error(
          "[context.record.publish] Version insert returned no row.",
        );
      }
      await tx
        .update(schema.contextRecords)
        .set({
          activeVersionId: versionRow.id,
          activatedByUserId: ctx.userId ?? undefined,
          activatedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.contextRecords.id, recordRow.id));
      // classification was already written on the insert above; the pin
      // update is the same as merge_context_pr's version-1 path.
      return { publicId: recordRow.publicId, slug: recordRow.slug };
    });

    logger.info(
      { slug, publicId: result.publicId, workspaceId },
      "context.record.publish: registered new record",
    );
    return {
      publicId: result.publicId,
      recordId: result.slug,
      version: 1,
      checksum,
      published: true,
    };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const winner = await findExisting();
      if (winner) {
        logger.info(
          { slug, workspaceId },
          "context.record.publish: lost insert race — publishing onto winner",
        );
        return publishVersionFor(winner);
      }
      throw new Error(
        `[context.record.publish] Record id "${slug}" is reserved by a deleted record in this workspace.`,
      );
    }
    throw err;
  }
};
