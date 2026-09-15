// mandate.expiry.ts — hourly cron that ends mandates past their validity
// window and gives back the authority their parked calls still hold
// (MC spec §6.9 "Mandates expire", ADR-059 decision 7).
//
// Per expired mandate, in the tenant's scope so the ledger writes carry the
// RLS GUCs, under the mandate row lock:
//   - every reservation held by an approval request that is still
//     unresolved, or resolved but never retried, is released;
//   - those approval rows resolve `expired`;
//   - the mandate flips `active` → `expired`;
//   - one `mandate.expired` security event is emitted.
// A mandate that fails is logged and skipped; the next run retries it.

import { and, eq, isNull, lt } from "drizzle-orm";
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { lockMandate, releaseParked } from "@oxagen/rules";
import { runInTenantScope } from "@oxagen/tenancy";
import { createFunction } from "../create-function";
import { logger } from "../logger";

const BATCH_SIZE = 500;

export const [mandateExpiry] = createFunction(
  {
    id: "mandate/expiry",
    retries: 3,
    concurrency: { limit: 1 },
  },
  { cron: "0 * * * *" },
  async ({ step }) => {
    const due = await step.run("find-expired-mandates", async () => {
      const now = new Date();
      // Cross-tenant scan: the job has no tenant scope of its own.
      return withSystemDb((tx) =>
        tx
          .select({
            id: schema.mandates.id,
            publicId: schema.mandates.publicId,
            orgId: schema.mandates.orgId,
            workspaceId: schema.mandates.workspaceId,
          })
          .from(schema.mandates)
          .where(
            and(
              eq(schema.mandates.status, "active"),
              lt(schema.mandates.validTo, now),
            ),
          )
          .limit(BATCH_SIZE),
      );
    });

    if (due.length === 0) {
      logger.info("mandate.expiry: nothing due");
      return { expired: 0 };
    }
    if (due.length === BATCH_SIZE) {
      logger.warn(
        { batchSize: BATCH_SIZE },
        "mandate.expiry: hit batch cap — the rest is processed next run",
      );
    }

    const expired = await step.run("expire-mandates", async () => {
      let count = 0;
      for (const mandate of due) {
        try {
          const released = await runInTenantScope(
            { orgId: mandate.orgId, workspaceId: mandate.workspaceId },
            () =>
              withTenantDb(async (tx) => {
                const locked = await lockMandate(tx, mandate.id);
                // Revoked or already expired since the scan: nothing to do.
                if (locked === null || locked.status !== "active") return null;
                const released = await releaseParked(tx, mandate.id);
                await tx
                  .update(schema.approvalRequests)
                  .set({ resolution: "expired", resolvedAt: new Date() })
                  .where(
                    and(
                      eq(schema.approvalRequests.mandateId, mandate.id),
                      isNull(schema.approvalRequests.resolution),
                    ),
                  );
                await tx
                  .update(schema.mandates)
                  .set({ status: "expired", updatedAt: new Date() })
                  .where(eq(schema.mandates.id, mandate.id));
                return released;
              }),
          );
          if (released === null) continue;
          await emitSecurityEventAsync({
            eventType: "mandate.expired",
            actorUserId: null,
            orgId: mandate.orgId,
            workspaceId: mandate.workspaceId,
            capability: null,
            outcome: "success",
            ip: null,
            userAgent: null,
            requestId: `mandate-expiry:${mandate.id}`,
          });
          logger.info(
            { mandateId: mandate.publicId, released },
            "mandate.expiry: expired",
          );
          count++;
        } catch (err) {
          logger.error(
            { mandateId: mandate.publicId, err },
            "mandate.expiry: failed for mandate (retried next run)",
          );
        }
      }
      return count;
    });

    logger.info({ expired, due: due.length }, "mandate.expiry complete");
    return { expired };
  },
);
