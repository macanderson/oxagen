// context.steering.publication.ts: the two writes every publication makes,
// shared by `merge_steering_pr` and the repository sync (ADR-061, ADR-184). A
// new version of a record, and the next link in the record's promotion chain.
// Both callers run these inside one transaction that holds the workspace's
// publication lock, so a merge from Oxagen and a sync triggered by the same
// merge never write two versions of one change.
import { schema, type withTenantDb } from "@oxagen/database";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { canonicalJson, sha256Hex } from "./registry-digest";

export type PublicationTx = Parameters<Parameters<typeof withTenantDb>[0]>[0];

interface Scope {
  orgId: string;
  workspaceId: string;
}

/**
 * Serialize every publication in one workspace. Taken first in the
 * transaction, before any read the publication decides on.
 */
export async function lockWorkspacePublication(
  tx: PublicationTx,
  workspaceId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`steering-publish:${workspaceId}`}, 0))`,
  );
}

/** The version row's classification: what its body says (#3312). */
export interface VersionClassification {
  kind: string;
  force: string;
  constraintEffect: string | null;
  statement: string;
}

/**
 * Insert the record's next version as the latest, and unset the previous
 * latest. `classificationReady` is false while migration `20260918160000` is
 * pending, and then the version carries no classification of its own.
 */
export async function appendVersion(
  tx: PublicationTx,
  args: {
    scope: Scope;
    recordId: string;
    body: string;
    checksum: string;
    publishedAt: Date;
    classification: VersionClassification;
    classificationReady: boolean;
    provenance: Record<string, unknown>[];
    byUserId: string | null;
  },
): Promise<{ id: string; version: number }> {
  const [latest] = await tx
    .select({
      id: schema.steeringRecordVersions.id,
      versionNumber: schema.steeringRecordVersions.versionNumber,
    })
    .from(schema.steeringRecordVersions)
    .where(
      and(
        eq(schema.steeringRecordVersions.recordId, args.recordId),
        eq(schema.steeringRecordVersions.isLatest, true),
      ),
    )
    .limit(1);
  if (latest) {
    await tx
      .update(schema.steeringRecordVersions)
      .set({ isLatest: false, updatedAt: args.publishedAt })
      .where(eq(schema.steeringRecordVersions.id, latest.id));
  }
  const version = (latest?.versionNumber ?? 0) + 1;
  const [row] = await tx
    .insert(schema.steeringRecordVersions)
    .values({
      orgId: args.scope.orgId,
      workspaceId: args.scope.workspaceId,
      recordId: args.recordId,
      versionNumber: version,
      isLatest: true,
      parentVersionId: latest?.id,
      publishedAt: args.publishedAt,
      body: args.body,
      checksum: args.checksum,
      // Omitted entirely while migration `20260918160000` is pending: naming
      // a column the database does not have raises 42703 and would fail the
      // publication outright. The record row still carries them.
      ...(args.classificationReady ? args.classification : {}),
      provenance: args.provenance,
      createdById: args.byUserId ?? undefined,
      updatedById: args.byUserId ?? undefined,
    })
    .returning({ id: schema.steeringRecordVersions.id });
  if (!row)
    throw new Error("[context.steering] version insert returned no row");
  return { id: row.id, version };
}

/**
 * Append the next event to the record's hash-chained promotion ledger. The
 * workspace's ledger length before it is its steering version, which the
 * caller reports.
 */
export async function appendPromotion(
  tx: PublicationTx,
  args: {
    scope: Scope;
    recordId: string;
    versionId: string | null;
    action: "promote" | "retire";
    approverUserId: string | null;
    policyVersion: string;
  },
): Promise<{
  id: string;
  publicId: string;
  seq: number;
  chainDigest: string;
  ledgerBefore: number;
}> {
  const [ledger] = await tx
    .select({ total: count() })
    .from(schema.steeringPromotions)
    .where(
      and(
        eq(schema.steeringPromotions.orgId, args.scope.orgId),
        eq(schema.steeringPromotions.workspaceId, args.scope.workspaceId),
      ),
    );
  const [head] = await tx
    .select({
      seq: schema.steeringPromotions.seq,
      chainDigest: schema.steeringPromotions.chainDigest,
    })
    .from(schema.steeringPromotions)
    .where(eq(schema.steeringPromotions.recordId, args.recordId))
    .orderBy(desc(schema.steeringPromotions.seq))
    .limit(1);
  const seq = (head?.seq ?? 0) + 1;
  const prevChainDigest = head?.chainDigest ?? null;
  const chainDigest = sha256Hex(
    (prevChainDigest ?? "") +
      canonicalJson({
        action: args.action,
        approver_user_id: args.approverUserId,
        policy_version: args.policyVersion,
        record_id: args.recordId,
        seq,
        version_id: args.versionId,
      }),
  );
  const [row] = await tx
    .insert(schema.steeringPromotions)
    .values({
      orgId: args.scope.orgId,
      workspaceId: args.scope.workspaceId,
      recordId: args.recordId,
      versionId: args.versionId,
      seq,
      action: args.action,
      approverUserId: args.approverUserId,
      policyVersion: args.policyVersion,
      prevChainDigest,
      chainDigest,
      createdById: args.approverUserId ?? undefined,
    })
    .returning({
      id: schema.steeringPromotions.id,
      publicId: schema.steeringPromotions.publicId,
    });
  if (!row)
    throw new Error("[context.steering] promotion insert returned no row");
  return {
    id: row.id,
    publicId: row.publicId,
    seq,
    chainDigest,
    ledgerBefore: ledger?.total ?? 0,
  };
}
