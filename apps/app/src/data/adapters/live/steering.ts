// The live steering adapter (Batch 3, lane A6).
//
//   records               wired: agent.context_records ⨝ its active
//                         agent.context_record_versions row, plus the latest
//                         `promote` entry in agent.context_promotions, read
//                         under the tenant scope (RLS) and mapped by
//                         ./mappers/steering.ts through the SteeringRecord schema.
//   proposals             not backed (M3). agent.context_promotions is the
//                         applied lifecycle ledger (promote / retire / supersede,
//                         each already decided): it has no candidate state, no
//                         support, no source and no Context PR, so a ledger
//                         entry shown as a proposal would claim a review that
//                         never happened. Proposals arrive with the promoter (M3).
//   effect, retirement    not backed (M3 effect metrics, src/data/backing.ts).
import "server-only";
import { schema, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, isNull, max } from "drizzle-orm";
import { notBackedFor } from "@/data/backing";
import { NO_GAP, notBacked, readError } from "@/data/not-backed";
import type { SteeringReadPort } from "@/data/ports";
import { ORG_ONLY_WORKSPACE_ID, type Scope } from "@/data/scope";
import { type ContextRecordRow, readSteeringRecords } from "./mappers/steering";

/** Steering is a workspace page: the organization-only sentinel names no workspace. */
export const WORKSPACE_SCOPE_REQUIRED = "workspace_scope_required";

/** Every live record in the workspace with its active version, ordered by slug. */
export async function selectContextRecordRows(
  scope: Scope,
): Promise<ContextRecordRow[]> {
  const records = schema.contextRecords;
  const versions = schema.contextRecordVersions;
  const promotions = schema.contextPromotions;
  return runInTenantScope(scope, () =>
    withTenantDb(async (tx) => {
      const promoted = tx
        .select({
          recordId: promotions.recordId,
          versionId: promotions.versionId,
          promotedAt: max(promotions.createdAt).as("promoted_at"),
        })
        .from(promotions)
        .where(eq(promotions.action, "promote"))
        .groupBy(promotions.recordId, promotions.versionId)
        .as("promoted");
      return (
        tx
          .select({
            publicId: records.publicId,
            slug: records.slug,
            status: records.status,
            body: versions.body,
            provenance: versions.provenance,
            versionPublishedAt: versions.publishedAt,
            promotedAt: promoted.promotedAt,
          })
          .from(records)
          // A record with no active version has published nothing yet.
          .innerJoin(versions, eq(versions.id, records.activeVersionId))
          .leftJoin(
            promoted,
            and(
              eq(promoted.recordId, records.id),
              eq(promoted.versionId, records.activeVersionId),
            ),
          )
          .where(
            and(
              eq(records.orgId, scope.orgId),
              eq(records.workspaceId, scope.workspaceId),
              isNull(records.deletedAt),
            ),
          )
          .orderBy(records.slug)
      );
    }),
  );
}

export const liveSteering: SteeringReadPort = {
  async records(scope) {
    if (scope.workspaceId === ORG_ONLY_WORKSPACE_ID)
      return readError(WORKSPACE_SCOPE_REQUIRED, 400);
    return readSteeringRecords(await selectContextRecordRows(scope));
  },
  proposals: () => Promise.resolve(notBacked("M3", NO_GAP)),
  effect: () => Promise.resolve(notBackedFor("steering", "effect")),
  retirementCandidates: () =>
    Promise.resolve(notBackedFor("steering", "retirementCandidates")),
};
