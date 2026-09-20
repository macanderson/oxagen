// mandate.expiry.ts — hourly cron that ends mandates past their validity
// window and voids approvals past their window, giving back the authority
// each still holds (MC spec §6.9 "Mandates expire", ADR-059 decision 7).
//
// Step one, per expired mandate, in the tenant's scope so the ledger writes
// carry the RLS GUCs, under the mandate row lock:
//   - every reservation held by an approval request that is still
//     unresolved, or resolved but never retried, is released;
//   - those approval rows resolve `expired`;
//   - the mandate flips `active` → `expired`;
//   - one `mandate.expired` security event is emitted.
// Step two, per approval row a mandate parked whose `expires_at` lapsed
// before the agent retried — unresolved, or approved and never used —
// under the same lock: the reservation is released and the row resolves
// `expired`, so a period's remaining authority is what open calls hold.
// Ordinary unresolved approvals also expire at their recorded deadline.
// Their conditional update preserves any concurrent human decision.
// A mandate or row that fails is logged and skipped; the next run retries it.

import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { schema, withSystemDb, withTenantDb, type Tx } from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import {
  expireApproval,
  lockMandate,
  releaseParked,
  type MandateRecord,
} from "@oxagen/rules";
import { runInTenantScope } from "@oxagen/tenancy";
import { createFunction } from "../create-function";
import { logger } from "../logger";

const BATCH_SIZE = 500;

/** The tenant of a mandate row, as both scans return it. */
interface MandateRef {
  id: string;
  orgId: string;
  workspaceId: string;
}

/** Run `fn` in the mandate's tenant scope under its row lock; null when the row is gone. */
function underMandateLock<T>(
  mandate: MandateRef,
  fn: (tx: Tx, locked: MandateRecord) => Promise<T>,
): Promise<T | null> {
  return runInTenantScope(
    { orgId: mandate.orgId, workspaceId: mandate.workspaceId },
    () =>
      withTenantDb(async (tx) => {
        const locked = await lockMandate(tx, mandate.id);
        return locked === null ? null : fn(tx, locked);
      }),
  );
}

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

    if (due.length === BATCH_SIZE) {
      logger.warn(
        { batchSize: BATCH_SIZE },
        "mandate.expiry: hit batch cap — the rest is processed next run",
      );
    }

    const expired =
      due.length === 0
        ? 0
        : await step.run("expire-mandates", async () => {
            let count = 0;
            for (const mandate of due) {
              try {
                const released = await underMandateLock(
                  mandate,
                  async (tx, locked) => {
                    // Revoked or already expired since the scan: nothing to do.
                    if (locked.status !== "active") return null;
                    const released = await releaseParked(tx, locked);
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
                  },
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

    const lapsed = await step.run("find-lapsed-approvals", async () => {
      const now = new Date();
      return withSystemDb(async (tx) => {
        const findBatch = (hasMandate: boolean) =>
          tx
            .select({
              id: schema.approvalRequests.id,
              mandateId: schema.approvalRequests.mandateId,
              toolCallId: schema.approvalRequests.toolCallId,
              orgId: schema.approvalRequests.orgId,
              workspaceId: schema.approvalRequests.workspaceId,
            })
            .from(schema.approvalRequests)
            .where(
              and(
                hasMandate
                  ? isNotNull(schema.approvalRequests.mandateId)
                  : isNull(schema.approvalRequests.mandateId),
                isNull(schema.approvalRequests.tokenUsedAt),
                lt(schema.approvalRequests.expiresAt, now),
                or(
                  isNull(schema.approvalRequests.resolution),
                  and(
                    isNotNull(schema.approvalRequests.mandateId),
                    eq(schema.approvalRequests.resolution, "approved"),
                  ),
                ),
              ),
            )
            .limit(BATCH_SIZE);
        // Separate limits keep ordinary timeouts from starving held authority.
        const mandates = await findBatch(true);
        const ordinary = await findBatch(false);
        return [...mandates, ...ordinary];
      });
    });

    const voided =
      lapsed.length === 0
        ? 0
        : await step.run("expire-lapsed-approvals", async () => {
            let count = 0;
            for (const row of lapsed) {
              try {
                if (row.mandateId === null) {
                  const updated = await runInTenantScope(
                    { orgId: row.orgId, workspaceId: row.workspaceId },
                    () =>
                      withTenantDb((tx) =>
                        tx
                          .update(schema.approvalRequests)
                          .set({
                            resolution: "expired",
                            resolvedAt: sql`${schema.approvalRequests.expiresAt}`,
                          })
                          .where(
                            and(
                              eq(schema.approvalRequests.id, row.id),
                              eq(schema.approvalRequests.orgId, row.orgId),
                              eq(
                                schema.approvalRequests.workspaceId,
                                row.workspaceId,
                              ),
                              isNull(schema.approvalRequests.mandateId),
                              isNull(schema.approvalRequests.resolution),
                              isNull(schema.approvalRequests.tokenUsedAt),
                              lt(schema.approvalRequests.expiresAt, new Date()),
                            ),
                          )
                          .returning({ id: schema.approvalRequests.id }),
                      ),
                  );
                  count += updated.length;
                  continue;
                }
                const released = await underMandateLock(
                  {
                    id: row.mandateId,
                    orgId: row.orgId,
                    workspaceId: row.workspaceId,
                  },
                  (tx, locked) => expireApproval(tx, locked, row, new Date()),
                );
                if (released === null) continue;
                logger.info(
                  { approvalId: row.id, mandateId: row.mandateId, released },
                  "mandate.expiry: approval lapsed",
                );
                count++;
              } catch (err) {
                logger.error(
                  { approvalId: row.id, err },
                  "mandate.expiry: failed for approval (retried next run)",
                );
              }
            }
            return count;
          });

    logger.info(
      { expired, due: due.length, voided, lapsed: lapsed.length },
      "mandate.expiry complete",
    );
    return { expired, voided };
  },
);
