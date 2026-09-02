// security.audit-partition-rollover.ts — monthly cron that manages Postgres
// partitions for security.security_events.
//
// Runs on the 1st of each month at 03:00 UTC (well after the billing rollup and
// dunning sweep). Two idempotent steps:
//
//   1. CREATE the next 2 monthly partitions if they don't already exist, so
//      inserts for the coming 60 days always land in a named partition rather
//      than the DEFAULT safety-net partition.
//
//   2. DROP any named partition whose entire date range is older than 7 years
//      from today (7-year SOC2 retention, matching ClickHouse audit_events TTL).
//      The DEFAULT partition is never dropped — it is the permanent safety net.
//
// Partition naming: security_events_<YYYY>_<MM>  (zero-padded month).
// Example: security_events_2026_06 covers [2026-06-01, 2026-07-01).
//
// Dependencies: @oxagen/database (withSystemDb + sql). No pg_partman / pg_cron
// assumed. Partition DDL is system-level (cross-tenant, no tenant scope), so it
// runs through withSystemDb — the explicit, audited RLS-bypass seam for trusted
// cron jobs (OXA-1515). All statements here are transaction-safe DDL (no
// CONCURRENTLY), so a single withSystemDb transaction per step is correct.
//
// Instrumentation: logs created/skipped/dropped counts at info level with
// durationMs so the Inngest dashboard + any log sink can track partition health.

import { sql } from "drizzle-orm";
import { createFunction } from "../create-function";
import { withSystemDb } from "@oxagen/database";
import { logger } from "../logger";

/** 7-year retention in milliseconds. */
const RETENTION_MS = 7 * 365.25 * 24 * 60 * 60 * 1000;

/**
 * Return the partition table name and ISO date bounds for a given year + month
 * (1-indexed month). Partition covers [first of month, first of next month).
 */
function partitionSpec(
  year: number,
  month: number,
): {
  name: string;
  from: string;
  to: string;
} {
  const mm = String(month).padStart(2, "0");
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const mmNext = String(nextMonth).padStart(2, "0");
  return {
    name: `security_events_${year}_${mm}`,
    from: `${year}-${mm}-01 00:00:00+00`,
    to: `${nextYear}-${mmNext}-01 00:00:00+00`,
  };
}

export const [securityAuditPartitionRollover] = createFunction(
  {
    id: "security.audit-partition-rollover",
    retries: 3,
    // Concurrency: only one instance at a time (prevents double-create races).
    concurrency: { limit: 1 },
  },
  // First of each month at 03:00 UTC.
  { cron: "0 3 1 * *" },
  async ({ step }) => {
    const now = new Date();

    // ── Step 1: create next 2 monthly partitions ────────────────────────────
    const created: string[] = [];
    const skipped: string[] = [];

    await step.run("create-upcoming-partitions", async () => {
      const startMs = Date.now();

      await withSystemDb(async (tx) => {
        for (let offset = 1; offset <= 2; offset++) {
          const target = new Date(
            now.getFullYear(),
            now.getMonth() + offset,
            1,
          );
          const spec = partitionSpec(
            target.getFullYear(),
            target.getMonth() + 1,
          );

          // Check whether the child table already exists in pg_class.
          const existsRows = await tx.execute<{ exists: boolean }>(sql`
            SELECT EXISTS (
              SELECT 1
              FROM   pg_class      c
              JOIN   pg_namespace  n ON n.oid = c.relnamespace
              WHERE  n.nspname = 'security'
              AND    c.relname  = ${spec.name}
              AND    c.relkind  = 'r'
            ) AS exists
          `);

          // drizzle-orm execute returns an array of row objects.
          const exists =
            (existsRows as { exists: boolean }[])[0]?.exists ?? false;

          if (exists) {
            skipped.push(spec.name);
            continue;
          }

          // CREATE TABLE ... PARTITION OF. IF NOT EXISTS is a second idempotency
          // guard in case of a concurrent run between the check and the create.
          await tx.execute(
            sql.raw(
              `CREATE TABLE IF NOT EXISTS security.${spec.name}` +
                ` PARTITION OF security.security_events` +
                ` FOR VALUES FROM ('${spec.from}') TO ('${spec.to}')`,
            ),
          );
          created.push(spec.name);
        }
      });

      logger.info(
        { created, skipped, durationMs: Date.now() - startMs },
        "audit-partition-rollover: partitions created",
      );
    });

    // ── Step 2: drop expired partitions (> 7 years old) ────────────────────
    const dropped: string[] = [];

    await step.run("drop-expired-partitions", async () => {
      const startMs = Date.now();
      const retentionCutoff = new Date(now.getTime() - RETENTION_MS);

      await withSystemDb(async (tx) => {
        // List all named monthly child partitions of security.security_events.
        // We exclude the DEFAULT partition by name and filter by name pattern.
        const rows = await tx.execute<{ relname: string }>(sql`
          SELECT c.relname
          FROM   pg_inherits    i
          JOIN   pg_class       c  ON c.oid = i.inhrelid
          JOIN   pg_namespace   n  ON n.oid = c.relnamespace
          WHERE  i.inhparent = (
                   SELECT c2.oid
                   FROM   pg_class      c2
                   JOIN   pg_namespace  n2 ON n2.oid = c2.relnamespace
                   WHERE  n2.nspname = 'security'
                   AND    c2.relname  = 'security_events'
                 )
          AND    n.nspname = 'security'
          AND    c.relname LIKE 'security_events_%_%'
          AND    c.relname != 'security_events_default'
          ORDER  BY c.relname
        `);

        for (const row of rows as { relname: string }[]) {
          // Parse year and month from name: security_events_YYYY_MM.
          const match = /^security_events_(\d{4})_(\d{2})$/.exec(row.relname);
          if (!match) continue; // unexpected name — skip safely

          const [, yearStr, monthStr] = match;
          if (!yearStr || !monthStr) continue;
          const year = Number(yearStr);
          const month = Number(monthStr); // 1-indexed

          // Partition's upper bound = first day of the month AFTER this one.
          // If the upper bound is on or before the cutoff, the entire partition
          // is older than 7 years and eligible for deletion.
          const partitionEnd = new Date(
            month === 12 ? year + 1 : year,
            month === 12 ? 0 : month, // JS month: 0-indexed → month+1 = next
            1,
          );

          if (partitionEnd <= retentionCutoff) {
            await tx.execute(
              sql.raw(`DROP TABLE IF EXISTS security.${row.relname}`),
            );
            dropped.push(row.relname);
          }
        }
      });

      logger.info(
        {
          dropped,
          retentionCutoffISO: retentionCutoff.toISOString(),
          durationMs: Date.now() - startMs,
        },
        "audit-partition-rollover: expired partitions dropped",
      );
    });

    logger.info(
      { created, skipped, dropped, nowISO: now.toISOString() },
      "security.audit-partition-rollover complete",
    );

    return { created, skipped, dropped };
  },
);
