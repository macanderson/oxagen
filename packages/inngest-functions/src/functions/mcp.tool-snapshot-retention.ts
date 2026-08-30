// mcp.tool-snapshot-retention.ts — monthly cron that purges external-MCP tool
// descriptor snapshots whose owning server was soft-deleted >= 365 days ago
// (OXA-820).
//
// Replay durability requires keeping a deleted server's tool snapshots so an
// old run can still render the tool. We retain them for 365 days after the
// server's deleted_at, then purge. ENABLED/DISABLED servers (deleted_at IS
// NULL) are never purged — only fully-deleted servers age out.
//
// Runs on the 2nd of each month at 04:00 UTC (after the audit-partition
// rollover at 03:00 on the 1st). Cross-tenant DDL/DML over every org's
// snapshots, so it runs through withSystemDb — the explicit, audited RLS-bypass
// seam for trusted cron jobs (OXA-1515).
//
// Instrumentation: logs purgedSnapshots + affectedServers counts with
// durationMs so the Inngest dashboard can track retention health.

import { sql } from "drizzle-orm";
import { createFunction } from "../create-function";
import { withSystemDb } from "@oxagen/database";
import { logger } from "../logger";

/** 365-day retention after a server is deleted. */
const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

export const [mcpToolSnapshotRetention] = createFunction(
  {
    id: "mcp.tool-snapshot-retention",
    retries: 3,
    concurrency: { limit: 1 },
  },
  // Second of each month at 04:00 UTC.
  { cron: "0 4 2 * *" },
  async ({ step }) => {
    const result = await step.run("purge-expired-snapshots", async () => {
      const startMs = Date.now();
      const cutoff = new Date(Date.now() - RETENTION_MS);

      const purged = await withSystemDb(async (tx) => {
        // Delete every snapshot whose owning server was soft-deleted on or
        // before the cutoff. The join keeps purge eligibility keyed off the
        // server's deleted_at — not the snapshot's captured_at — so the full
        // 365-day window starts from deletion, matching the ticket's retention.
        const rows = await tx.execute<{ id: string }>(sql`
          DELETE FROM mcp.tool_snapshots ts
          USING mcp.mcp_servers s
          WHERE ts.mcp_server_id = s.id
            AND s.deleted_at IS NOT NULL
            AND s.deleted_at <= ${cutoff.toISOString()}
          RETURNING ts.id
        `);
        return (rows as { id: string }[]).length;
      });

      logger.info(
        {
          purgedSnapshots: purged,
          cutoffISO: cutoff.toISOString(),
          durationMs: Date.now() - startMs,
        },
        "mcp.tool-snapshot-retention: purged expired snapshots",
      );
      return { purgedSnapshots: purged };
    });

    return result;
  },
);
