import type { CapabilityHandler } from "@oxagen/oxagen";
import { contextRecordPublish } from "@oxagen/oxagen/contracts/context.record.publish";
import { schema, withTenantDb, isUniqueViolation } from "@oxagen/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { sha256Hex } from "./registry-digest";

/**
 * Publish one steering context record into the workspace agent-asset
 * registry — the platform mirror of adding a .stella/rules/<record_id>.toml
 * file. Upserts agent.context_records by (workspace, record_id) and creates
 * a new immutable version row only when the body checksum changed; an
 * unchanged body is idempotent (published: false). Same shape as
 * tool.declaration.publish.
 */
export const contextRecordPublishHandler: CapabilityHandler<
  typeof contextRecordPublish
> = async (input, ctx) => {
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

  const versionValues = {
    orgId,
    workspaceId,
    body: input.body,
    checksum,
    provenance,
    isLatest: true,
    publishedAt: sql`now()`,
    createdByUserId: ctx.userId ?? undefined,
    updatedByUserId: ctx.userId ?? undefined,
  };

  // Version-publish path against an existing record row: idempotent when the
  // latest version already carries this checksum, otherwise latest+1.
  const publishVersionFor = async (existing: {
    id: string;
    publicId: string;
    slug: string;
  }) => {
    const [latest] = await withTenantDb((tx) =>
      tx
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
        .limit(1),
    );

    if (latest && latest.checksum === checksum) {
      logger.info(
        { slug, publicId: existing.publicId, workspaceId },
        "context.record.publish: idempotent — checksum unchanged",
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
      const [versionRow] = await tx
        .insert(schema.contextRecordVersions)
        .values({
          ...versionValues,
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
          updatedByUserId: ctx.userId ?? undefined,
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
          createdByUserId: ctx.userId ?? undefined,
          updatedByUserId: ctx.userId ?? undefined,
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
      const [versionRow] = await tx
        .insert(schema.contextRecordVersions)
        .values({ ...versionValues, recordId: recordRow.id, versionNumber: 1 })
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
