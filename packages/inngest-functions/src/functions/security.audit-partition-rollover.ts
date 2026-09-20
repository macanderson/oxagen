import { sql } from "drizzle-orm";
import { z } from "zod";
import { withSystemDb } from "@oxagen/database";
import { createFunction } from "../create-function";
import { logger } from "../logger";

const maintenanceResult = z.object({
  created: z.array(z.string()),
  dropped: z.array(z.string()),
  expiredDefaultRows: z.number().int().nonnegative(),
  hasExpiredDefaultRows: z.boolean(),
});

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
      return result;
    }),
);
