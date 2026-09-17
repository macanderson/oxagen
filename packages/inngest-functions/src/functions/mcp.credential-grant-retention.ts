// mcp.credential-grant-retention.ts — weekly cron that purges credential-broker
// grants past their retention window (#2958, PR #3025 review).
//
// The broker mints one `mcp.credential_grants` row per server per
// materialization — per turn — with a one-hour TTL
// (packages/agent/src/runtime/plugin-types/mcp.ts). Revoking a connection and
// flipping a connection kill switch both set `revoked_at`; nothing ever
// deleted a row. A modest tenant running a handful of connected servers writes
// on the order of a thousand rows a day, and `list_credential_grants` pages
// over all of them for ever.
//
// The table answers one question: "what could a credential still reach, and
// what did it reach recently". A grant whose TTL ran out ninety days ago
// answers neither, and the durable record of a credential USE is the tool
// invocation in ClickHouse and the security event, neither of which this
// purge touches. So grants are kept 90 days past the point they stopped being
// live — `revoked_at` where the grant was revoked, `expires_at` otherwise —
// and then deleted.
//
// Sundays at 04:30 UTC, after the monthly snapshot retention's slot and clear
// of the audit-partition rollover. Cross-tenant DML over every org's grants,
// so it runs through withSystemDb — the explicit, audited RLS-bypass seam for
// trusted cron jobs.

import { sql } from "drizzle-orm";
import { createFunction } from "../create-function";
import { withSystemDb } from "@oxagen/database";
import { logger } from "../logger";

/** How long a grant is kept after it stopped being live. */
export const GRANT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Rows deleted per statement, so one pass never holds a long write lock. */
const BATCH = 5_000;

export const [mcpCredentialGrantRetention] = createFunction(
  {
    id: "mcp.credential-grant-retention",
    retries: 3,
    concurrency: { limit: 1 },
  },
  // Sundays at 04:30 UTC.
  { cron: "30 4 * * 0" },
  async ({ step }) => {
    const result = await step.run("purge-expired-grants", async () => {
      const startMs = Date.now();
      const cutoff = new Date(Date.now() - GRANT_RETENTION_MS);

      const purged = await withSystemDb(async (tx) => {
        let total = 0;
        for (;;) {
          // A grant stops being live at revoked_at when it was revoked, and at
          // expires_at otherwise. Both are indexed enough for this: the scan is
          // weekly and bounded by the batch.
          const rows = await tx.execute<{ id: string }>(sql`
            DELETE FROM mcp.credential_grants
            WHERE id IN (
              SELECT id FROM mcp.credential_grants
              WHERE COALESCE(revoked_at, expires_at) <= ${cutoff.toISOString()}
              LIMIT ${BATCH}
            )
            RETURNING id
          `);
          const deleted = (rows as { id: string }[]).length;
          total += deleted;
          if (deleted < BATCH) break;
        }
        return total;
      });

      logger.info(
        {
          purgedGrants: purged,
          cutoffISO: cutoff.toISOString(),
          durationMs: Date.now() - startMs,
        },
        "mcp.credential-grant-retention: purged grants past retention",
      );
      return { purgedGrants: purged };
    });

    return result;
  },
);
