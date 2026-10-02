import { and, eq, isNull } from "drizzle-orm";
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { steeringRecordLabel } from "@oxagen/oxagen/steering-record-label";
import { createFunction } from "../create-function";

/** Fill only missing display labels, including records written by older ingesters. */
export const [contextLabelsBackfill] = createFunction(
  { id: "context/labels-backfill", retries: 3, concurrency: { limit: 1 } },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    // tenancy: Global repair scans missing labels only; each write re-enters its stored org/workspace scope.
    const records = await step.run("find-missing-labels", () =>
      withSystemDb((tx) =>
        tx
          .select({
            id: schema.steeringRecords.id,
            orgId: schema.steeringRecords.orgId,
            workspaceId: schema.steeringRecords.workspaceId,
            slug: schema.steeringRecords.slug,
          })
          .from(schema.steeringRecords)
          .where(
            and(
              isNull(schema.steeringRecords.label),
              isNull(schema.steeringRecords.deletedAt),
            ),
          )
          .orderBy(schema.steeringRecords.id)
          .limit(500),
      ),
    );
    for (const record of records) {
      await step.run(`label-${record.id}`, () =>
        runInTenantScope(
          { orgId: record.orgId, workspaceId: record.workspaceId },
          () =>
            withTenantDb((tx) =>
              tx
                .update(schema.steeringRecords)
                .set({ label: steeringRecordLabel(record.slug) })
                .where(
                  and(
                    eq(schema.steeringRecords.id, record.id),
                    eq(schema.steeringRecords.orgId, record.orgId),
                    eq(schema.steeringRecords.workspaceId, record.workspaceId),
                    isNull(schema.steeringRecords.label),
                    isNull(schema.steeringRecords.deletedAt),
                  ),
                ),
            ),
        ),
      );
    }
    return { processed: records.length };
  },
);
