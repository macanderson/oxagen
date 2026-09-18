import type { CapabilityHandler } from "@oxagen/oxagen";
import { contextRecordPromote } from "@oxagen/oxagen/contracts/context.record.promote";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { logger } from "./logger";
import { canonicalJson, sha256Hex } from "./registry-digest";

const STATUS_BY_ACTION = {
  promote: "active",
  retire: "retired",
  supersede: "superseded",
} as const;

/**
 * Append one lifecycle action to a context record's hash-chained promotions
 * ledger and apply it to the record row — the platform mirror of appending a
 * line to Stella's .stella/rules/promotions.jsonl. The chain digest commits
 * to the predecessor: chain_digest = sha256(prev_chain_digest + canonical
 * row), so a rewritten or reordered ledger fails re-verification.
 *
 * A promote also refreshes the record row's classification from the version
 * it pins, so the bundle's steering text says what the pinned version says.
 */
export const contextRecordPromoteHandler: CapabilityHandler<
  typeof contextRecordPromote
> = async (input, ctx) => {
  // Resolve the record by publicId or slug (same dual resolution as
  // skill.version.list).
  const [record] = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.contextRecords.id,
        publicId: schema.contextRecords.publicId,
      })
      .from(schema.contextRecords)
      .where(
        and(
          or(
            eq(schema.contextRecords.publicId, input.record_id),
            eq(schema.contextRecords.slug, input.record_id),
          ),
          eq(schema.contextRecords.workspaceId, ctx.workspaceId),
          isNull(schema.contextRecords.deletedAt),
        ),
      )
      .limit(1),
  );
  if (!record) {
    throw new Error(
      `[context.record.promote] Record "${input.record_id}" not found in this workspace.`,
    );
  }

  // promote pins a version; the other actions may name one for the ledger.
  let versionUuid: string | null = null;
  // The pinned version's classification, copied onto the record row by a
  // promote so the row (and the steering text compiled from it) describes
  // the version in service, not the one merged last (#3312). Empty for a
  // version the legacy publish path wrote without one: the row keeps what it
  // has, which is the only classification that version ever had.
  let classification: Partial<
    Pick<
      typeof schema.contextRecords.$inferInsert,
      "kind" | "force" | "constraintEffect" | "statement"
    >
  > = {};
  if (input.version_id) {
    const [version] = await withTenantDb((tx) =>
      tx
        .select({
          id: schema.contextRecordVersions.id,
          kind: schema.contextRecordVersions.kind,
          force: schema.contextRecordVersions.force,
          constraintEffect: schema.contextRecordVersions.constraintEffect,
          statement: schema.contextRecordVersions.statement,
        })
        .from(schema.contextRecordVersions)
        .where(
          and(
            eq(schema.contextRecordVersions.publicId, input.version_id!),
            eq(schema.contextRecordVersions.recordId, record.id),
          ),
        )
        .limit(1),
    );
    if (!version) {
      throw new Error(
        `[context.record.promote] Version "${input.version_id}" does not belong to record "${input.record_id}".`,
      );
    }
    versionUuid = version.id;
    // A merge writes all four together, so `kind` alone tells a classified
    // version from a legacy one. `constraintEffect` is copied even when NULL:
    // a rule version promoted over a constraint must clear it, or the row's
    // check constraint refuses the update.
    if (version.kind != null) {
      classification = {
        kind: version.kind,
        force: version.force,
        constraintEffect: version.constraintEffect,
        statement: version.statement,
      };
    }
  } else if (input.action === "promote") {
    throw new Error(
      "[context.record.promote] `version_id` is required for a promote.",
    );
  }

  // The chain head: highest seq wins. The (record_id, seq) unique index turns
  // a racing double-append into a constraint violation instead of a fork.
  const [head] = await withTenantDb((tx) =>
    tx
      .select({
        seq: schema.contextPromotions.seq,
        chainDigest: schema.contextPromotions.chainDigest,
      })
      .from(schema.contextPromotions)
      .where(eq(schema.contextPromotions.recordId, record.id))
      .orderBy(desc(schema.contextPromotions.seq))
      .limit(1),
  );

  const seq = (head?.seq ?? 0) + 1;
  const prevChainDigest = head?.chainDigest ?? null;
  const approverUserId = ctx.userId ?? null;
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

  const status = STATUS_BY_ACTION[input.action];
  await withTenantDb(async (tx) => {
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
      createdById: ctx.userId ?? undefined,
    });
    await tx
      .update(schema.contextRecords)
      .set({
        status,
        ...(input.action === "promote"
          ? {
              activeVersionId: versionUuid,
              activatedByUserId: ctx.userId ?? undefined,
              activatedAt: sql`now()`,
              ...classification,
            }
          : {}),
        updatedById: ctx.userId ?? undefined,
        updatedAt: sql`now()`,
      })
      .where(eq(schema.contextRecords.id, record.id));
  });

  logger.info(
    {
      record_id: input.record_id,
      publicId: record.publicId,
      action: input.action,
      seq,
      workspaceId: ctx.workspaceId,
    },
    "context.record.promote: appended ledger entry",
  );

  return {
    recordId: record.publicId,
    action: input.action,
    seq,
    chainDigest,
    status,
  };
};
