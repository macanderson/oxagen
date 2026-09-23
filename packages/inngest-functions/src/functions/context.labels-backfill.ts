import { and, eq, isNull } from "drizzle-orm";
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { contextRecordLabel } from "@oxagen/oxagen/context-record-label";
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
            id: schema.contextRecords.id,
            orgId: schema.contextRecords.orgId,
            workspaceId: schema.contextRecords.workspaceId,
            slug: schema.contextRecords.slug,
          })
          .from(schema.contextRecords)
          .where(
            and(
              isNull(schema.contextRecords.label),
              isNull(schema.contextRecords.deletedAt),
            ),
          )
          .orderBy(schema.contextRecords.id)
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
                .update(schema.contextRecords)
                .set({ label: contextRecordLabel(record.slug) })
                .where(
                  and(
                    eq(schema.contextRecords.id, record.id),
                    eq(schema.contextRecords.orgId, record.orgId),
                    eq(schema.contextRecords.workspaceId, record.workspaceId),
                    isNull(schema.contextRecords.label),
                    isNull(schema.contextRecords.deletedAt),
                  ),
                ),
            ),
        ),
      );
    }
    return { processed: records.length };
  },
);
