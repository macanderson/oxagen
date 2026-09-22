import { sql } from "drizzle-orm";
import { z } from "zod";
import { withSystemDb } from "@oxagen/database";
import { createFunction } from "../create-function";
import { logger } from "../logger";

// One step the database rolled back on its own so the rest of maintenance could
// commit: a month it could not prepare, an expired partition it could not drop,
// or a DEFAULT drain that failed. `pendingRows` counts the audit rows still
// waiting in DEFAULT because of that step.
const skippedWork = z.object({
  partition: z.string(),
  phase: z.enum(["create", "drop", "drain"]),
  sqlstate: z.string(),
  reason: z.string(),
  pendingRows: z.number().int().nonnegative(),
});

const maintenanceResult = z.object({
  created: z.array(z.string()),
  dropped: z.array(z.string()),
  expiredDefaultRows: z.number().int().nonnegative(),
  hasExpiredDefaultRows: z.boolean(),
  skipped: z.array(skippedWork),
  hasSkippedPartitions: z.boolean(),
});

/**
 * Raised after maintenance commits with steps the database had to skip. The
 * months and retention that succeeded stand. The run still fails, so a skip is
 * recorded rather than passed over.
 */
export class AuditPartitionMaintenanceError extends Error {
  readonly code = "audit_partition_maintenance_incomplete" as const;
  constructor(readonly skipped: z.infer<typeof skippedWork>[]) {
    const steps = skipped
      .map((entry) => `${entry.partition} (${entry.phase}, ${entry.sqlstate})`)
      .join(", ");
    super(
      `Audit partition maintenance skipped ${skipped.length} step${skipped.length === 1 ? "" : "s"}: ${steps}`,
    );
    this.name = "AuditPartitionMaintenanceError";
  }
}

export const [securityAuditPartitionRollover] = createFunction(
  {
    id: "security.audit-partition-rollover",
    retries: 3,
    concurrency: { limit: 1 },
  },
  // Daily catch-up also drains expired rows from the preserved DEFAULT heap.
  { cron: "0 3 * * *" },
  async ({ step }) =>
    step.run("maintain-audit-partitions", async () => {
      const startedAt = Date.now();
      // ADR-125: the database owns the dates, identifiers, lock, and bounded DDL.
      // This trusted cross-tenant cron receives no caller-selected maintenance inputs.
      const result = await withSystemDb(async (tx) => {
        const rows = await tx.execute<{ result: unknown }>(sql`
        SELECT security.maintain_audit_partitions() AS result
      `);
        return maintenanceResult.parse(rows[0]?.result);
      });
      logger.info(
        { ...result, durationMs: Date.now() - startedAt },
        "Audit partition maintenance complete",
      );
      if (result.hasExpiredDefaultRows) {
        logger.warn(
          { expiredDefaultRows: result.expiredDefaultRows },
          "Expired audit rows remain for the next maintenance batch",
        );
      }
      if (result.hasSkippedPartitions) {
        // The transaction has committed, so the work that succeeded is durable.
        // Fail the run afterwards: a skipped partition is a defect to look at.
        logger.error(
          { skipped: result.skipped },
          "Audit partition maintenance skipped work",
        );
        throw new AuditPartitionMaintenanceError(result.skipped);
      }
      return result;
    }),
);
