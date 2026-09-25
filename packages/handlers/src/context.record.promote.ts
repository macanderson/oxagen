import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { contextRecordPromote } from "@oxagen/oxagen/contracts/context.record.promote";
import {
  ambientPlaneKey,
  CONTEXT_VERSION_CLASSIFICATION_COLUMN,
  hasColumnFresh,
  schema,
  withTenantDb,
} from "@oxagen/database";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { logger } from "./logger";
import { canonicalJson, sha256Hex } from "./registry-digest";
import { isRepositoryRecord } from "./context.steering.sync.plan";

const STATUS_BY_ACTION = {
  promote: "active",
  retire: "retired",
  supersede: "superseded",
} as const;

/** Append the action and close or reopen validity under one record lock. */
export const contextRecordPromoteHandler: CapabilityHandler<
  typeof contextRecordPromote
> = async (input, ctx) => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: ["Owner", "Admin"], workspace: ["Owner", "Admin"] },
  );
  const result = await withTenantDb(async (tx) => {
    const [record] = await tx
      .select({
        id: schema.contextRecords.id,
        publicId: schema.contextRecords.publicId,
        slug: schema.contextRecords.slug,
        path: schema.contextRecords.path,
        status: schema.contextRecords.status,
        validUntil: schema.contextRecords.validUntil,
      })
      .from(schema.contextRecords)
      .where(
        and(
          or(
            eq(schema.contextRecords.publicId, input.record_id),
            eq(schema.contextRecords.slug, input.record_id),
          ),
          eq(schema.contextRecords.orgId, ctx.orgId),
          eq(schema.contextRecords.workspaceId, ctx.workspaceId),
          isNull(schema.contextRecords.deletedAt),
        ),
      )
      .for("update")
      .limit(1);
    if (!record)
      throw new HandlerError({
        code: "not_found",
        reason: "context_record_missing",
        message: `[context.record.promote] Record "${input.record_id}" not found in this workspace.`,
      });
    // A record whose file lives on the production branch follows the
    // repository (ADR-184). Retiring or pinning it here would hold only until
    // the next sync read the file back, and then silently revert, so the
    // change is refused and pointed at the file.
    if (isRepositoryRecord(record.path))
      throw new HandlerError({
        code: "conflict",
        reason: "record_follows_repository",
        message: `${record.slug} lives in ${record.path} on the production branch, and Oxagen follows the repository. Change the file with a Context PR: remove it or set its status to retracted to retire the record.`,
      });

    let versionUuid: string | null = null;
    if (input.version_id) {
      const [version] = await tx
        .select({ id: schema.contextRecordVersions.id })
        .from(schema.contextRecordVersions)
        .where(
          and(
            eq(schema.contextRecordVersions.publicId, input.version_id),
            eq(schema.contextRecordVersions.recordId, record.id),
            eq(schema.contextRecordVersions.orgId, ctx.orgId),
            eq(schema.contextRecordVersions.workspaceId, ctx.workspaceId),
          ),
        )
        .limit(1);
      if (!version)
        throw new HandlerError({
          code: "not_found",
          reason: "context_version_missing",
          message: `[context.record.promote] Version "${input.version_id}" does not belong to record "${input.record_id}".`,
        });
      versionUuid = version.id;
    } else if (input.action === "promote") {
      throw new HandlerError({
        code: "conflict",
        reason: "context_version_required",
        message:
          "[context.record.promote] `version_id` is required for a promote.",
      });
    }
    const [head] = await tx
      .select({
        seq: schema.contextPromotions.seq,
        chainDigest: schema.contextPromotions.chainDigest,
        action: schema.contextPromotions.action,
      })
      .from(schema.contextPromotions)
      .where(eq(schema.contextPromotions.recordId, record.id))
      .orderBy(desc(schema.contextPromotions.seq))
      .limit(1);
    const status = STATUS_BY_ACTION[input.action];
    if (
      input.action !== "promote" &&
      record.status === status &&
      head?.action === input.action
    ) {
      return {
        recordId: record.publicId,
        action: input.action,
        seq: head.seq,
        chainDigest: head.chainDigest,
        status,
        validUntil: record.validUntil?.toISOString() ?? null,
      };
    }
    const now = new Date();
    const validUntil =
      input.action === "promote" ? null : (record.validUntil ?? now);
    const seq = (head?.seq ?? 0) + 1;
    const prevChainDigest = head?.chainDigest ?? null;
    const approverUserId = actingUserId ?? null;
    const chainDigest = sha256Hex(
      (prevChainDigest ?? "") +
        canonicalJson({
          action: input.action,
          approver_user_id: approverUserId,
          policy_version: input.policy_version,
          record_id: record.id,
          seq,
          version_id: versionUuid,
        }),
    );
    // The pinned version's classification, copied onto the record row so the
    // row -- and the steering text compiled from it, and the listing and the
    // classification filters that read it -- describes the version in service
    // rather than the one merged last (#3312).
    //
    // Read HERE, in the transaction that writes it, and not in the lookup
    // above: that one commits first, so a migration landing between the two
    // would leave this update copying nothing while the pin moved, and the row
    // would describe the PREVIOUSLY active version until somebody promoted
    // again -- which nothing guarantees ever happens
    // (discussion_r4050583312).
    //
    // ACCESS SHARE before the probe, for the same reason `publishMerge` takes
    // ROW EXCLUSIVE: `information_schema` locks nothing, so without it the
    // `ALTER TABLE` could still commit between a `false` answer and this read.
    // ACCESS SHARE is what the SELECT below takes anyway and conflicts only
    // with ACCESS EXCLUSIVE, so it serializes against the DDL and against
    // nothing else.
    let classification: Partial<
      Pick<
        typeof schema.contextRecords.$inferInsert,
        "kind" | "force" | "constraintEffect" | "statement"
      >
    > = {};
    if (input.action === "promote" && versionUuid) {
      await tx.execute(
        sql`lock table ${schema.contextRecordVersions} in access share mode`,
      );
      const ready = await hasColumnFresh(
        tx,
        CONTEXT_VERSION_CLASSIFICATION_COLUMN,
        await ambientPlaneKey(),
      );
      if (ready) {
        const [pinned] = await tx
          .select({
            kind: schema.contextRecordVersions.kind,
            force: schema.contextRecordVersions.force,
            constraintEffect: schema.contextRecordVersions.constraintEffect,
            statement: schema.contextRecordVersions.statement,
          })
          .from(schema.contextRecordVersions)
          .where(eq(schema.contextRecordVersions.id, versionUuid))
          .limit(1);
        // A merge writes all four together, so `kind` alone tells a classified
        // version from a legacy one -- but narrowing on `kind` alone does not
        // tell TypeScript `force` is non-null too, so it is named in the
        // guard as well. Every real
        // writer sets both together (`publishMerge`, `publish_context_record`
        // since #3302), so this never actually excludes a version `kind`
        // alone would have accepted. `constraintEffect` is copied even when
        // NULL: a rule version promoted over a constraint must clear it, or
        // the row's check constraint refuses the update.
        if (pinned?.kind != null && pinned.force != null) {
          classification = {
            kind: pinned.kind,
            force: pinned.force,
            constraintEffect: pinned.constraintEffect,
            statement: pinned.statement,
          };
        }
      }
    }

    await tx.insert(schema.contextPromotions).values({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      recordId: record.id,
      versionId: versionUuid,
      seq,
      action: input.action,
      approverUserId,
      policyVersion: input.policy_version,
      prevChainDigest,
      chainDigest,
      createdById: actingUserId ?? undefined,
    });
    await tx
      .update(schema.contextRecords)
      .set({
        status,
        validUntil,
        ...(input.action === "promote"
          ? {
              activeVersionId: versionUuid,
              activatedByUserId: actingUserId ?? undefined,
              activatedAt: now,
              ...classification,
            }
          : {}),
        updatedById: actingUserId ?? undefined,
        updatedAt: now,
      })
      .where(eq(schema.contextRecords.id, record.id));
    return {
      recordId: record.publicId,
      action: input.action,
      seq,
      chainDigest,
      status,
      validUntil: validUntil?.toISOString() ?? null,
    };
  });
  logger.info(
    {
      record_id: input.record_id,
      action: input.action,
      seq: result.seq,
      workspaceId: ctx.workspaceId,
    },
    "context.record.promote: lifecycle recorded",
  );
  return result;
};
