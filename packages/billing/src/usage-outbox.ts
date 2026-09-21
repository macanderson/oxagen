import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, isNotNull, lte, sql } from "drizzle-orm";
import { schema, withSystemDb, type Tx } from "@oxagen/database";
import { insertDurableTokenUsage, type TokenUsageRow } from "@oxagen/telemetry";
import { requireScope } from "@oxagen/tenancy";
import {
  chargeUsageCredits,
  snapshotUsageCharge,
  type ChargeUsageArgs,
} from "./metering";
import { recordSpend } from "./spend-counter";
import { logger } from "./logger";

type Entry = typeof schema.usageOutbox.$inferSelect;
function assertUsageScope(orgId: string, workspaceId: string): void {
  const scope = requireScope();
  if (scope.orgId !== orgId || scope.workspaceId !== workspaceId)
    throw new Error("Usage scope differs from the active tenant.");
}

/** Persist an admission before contacting the provider. Failure refuses the call. */
export async function admitUsage(
  orgId: string,
  workspaceId: string,
): Promise<string> {
  assertUsageScope(orgId, workspaceId);
  const id = randomUUID();
  // tenancy: orgId and workspaceId match the verified active scope before shared-plane admission.
  await withSystemDb((tx) =>
    tx.insert(schema.usageOutbox).values({ id, orgId, workspaceId }),
  );
  return id;
}

async function settle(tx: Tx, entry: Entry): Promise<void> {
  if (entry.finalizedAt !== null || entry.payload === null) return;
  const row = entry.payload as unknown as TokenUsageRow;
  const charge = entry.charge as unknown as ChargeUsageArgs | null;
  await recordSpend(
    {
      orgId: entry.orgId,
      workspaceId: entry.workspaceId,
      at: new Date(row.created_at),
      micros: BigInt(Math.max(0, Math.round(row.cost_usd_micros))),
    },
    tx,
  );
  if (charge) await chargeUsageCredits(charge, tx);
  // Carry, lots, ledger, counter, and settlement marker share this transaction.
  await tx
    .update(schema.usageOutbox)
    .set({ finalizedAt: new Date() })
    .where(eq(schema.usageOutbox.id, entry.id));
}

/** Stage usage durably before settlement, so a debit failure can be retried. */
export async function finalizeUsage(args: {
  id: string;
  row: TokenUsageRow;
  charge?: ChargeUsageArgs;
  complete?: boolean;
}): Promise<void> {
  assertUsageScope(args.row.org_id, args.row.workspace_id);
  if (args.charge && args.charge.orgId !== args.row.org_id)
    throw new Error("Usage charge scope differs from admission.");
  const predicate = and(
    eq(schema.usageOutbox.id, args.id),
    eq(schema.usageOutbox.orgId, args.row.org_id),
    eq(schema.usageOutbox.workspaceId, args.row.workspace_id),
  );
  // tenancy: filtered by orgId and workspaceId after verified active tenant scope.
  await withSystemDb(async (tx) => {
    const [entry] = await tx
      .select()
      .from(schema.usageOutbox)
      .where(predicate)
      .for("update");
    if (!entry) throw new Error("Usage admission is missing.");
    if (entry.finalizedAt !== null || entry.payload !== null) return;
    await tx
      .update(schema.usageOutbox)
      .set({
        payload: { ...args.row },
        charge: args.charge ? { ...snapshotUsageCharge(args.charge) } : null,
        usageComplete: args.complete ?? true,
      })
      .where(predicate);
  });
  // tenancy: filtered by orgId and workspaceId after verified active tenant scope.
  await withSystemDb(async (tx) => {
    const [entry] = await tx
      .select()
      .from(schema.usageOutbox)
      .where(predicate)
      .for("update");
    if (!entry) throw new Error("Usage admission is missing.");
    await settle(tx, entry);
  });
}

/** Cross-tenant scheduled delivery. Every mutation names its locked admission. */
export async function deliverUsageOutbox(
  limit = 100,
  eligibleBefore = new Date(),
): Promise<{
  selected: number;
  delivered: number;
  failed: number;
  incomplete: number;
}> {
  let delivered = 0;
  let failed = 0;
  // tenancy: scheduled cross-tenant delivery reads bounded pending shared-plane admissions.
  const pending = await withSystemDb((tx) =>
    tx
      .select({ id: schema.usageOutbox.id })
      .from(schema.usageOutbox)
      .where(
        and(
          isNull(schema.usageOutbox.deliveredAt),
          isNotNull(schema.usageOutbox.payload),
          lte(schema.usageOutbox.nextAttemptAt, eligibleBefore),
        ),
      )
      .orderBy(asc(schema.usageOutbox.nextAttemptAt))
      .limit(limit),
  );
  for (const { id } of pending) {
    try {
      // tenancy: scheduled cross-tenant settlement locks the selected admission before mutation.
      await withSystemDb(async (tx) => {
        const [entry] = await tx
          .select()
          .from(schema.usageOutbox)
          .where(
            and(
              eq(schema.usageOutbox.id, id),
              isNull(schema.usageOutbox.deliveredAt),
            ),
          )
          .for("update", { skipLocked: true });
        if (!entry || !entry.payload) return;
        await settle(tx, entry);
        await insertDurableTokenUsage(
          entry.id,
          entry.payload as unknown as TokenUsageRow,
        );
        // Keep the identity after delivery to fence repeated finalizers. The
        // temporary delivery body and debit instructions are no longer needed.
        await tx
          .update(schema.usageOutbox)
          .set({ deliveredAt: new Date(), payload: null, charge: null })
          .where(eq(schema.usageOutbox.id, id));
        delivered++;
      });
    } catch (err) {
      failed++;
      // A failed debit or uncertain ClickHouse acknowledgment leaves the body.
      // No finite retry count discards usage. Each record has its own backoff.
      // tenancy: scheduled cross-tenant retry updates only the selected undelivered admission.
      await withSystemDb((tx) =>
        tx
          .update(schema.usageOutbox)
          .set({
            attempts: sql`${schema.usageOutbox.attempts} + 1`,
            nextAttemptAt: sql`now() + least(3600, power(2, least(${schema.usageOutbox.attempts}, 12))) * interval '1 second'`,
          })
          .where(
            and(
              eq(schema.usageOutbox.id, id),
              isNull(schema.usageOutbox.deliveredAt),
            ),
          ),
      );
      logger.error(
        { err, usageId: id },
        "Usage retained for settlement or delivery retry",
      );
    }
  }
  // tenancy: scheduled cross-tenant reconciliation counts incomplete shared-plane admissions globally.
  const [unknown] = await withSystemDb((tx) =>
    tx
      .select({ count: sql<number>`count(*)::integer` })
      .from(schema.usageOutbox)
      .where(
        and(
          eq(schema.usageOutbox.usageComplete, false),
          lte(schema.usageOutbox.admittedAt, new Date(Date.now() - 3_600_000)),
        ),
      ),
  );
  const incomplete = unknown?.count ?? 0;
  if (incomplete > 0)
    logger.error(
      { incomplete, alert: "billing_usage_incomplete" },
      "Provider usage needs reconciliation",
    );
  return { selected: pending.length, delivered, failed, incomplete };
}
