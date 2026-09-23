import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNull,
  isNotNull,
  lte,
  sql,
} from "drizzle-orm";
import { schema, withSystemDb, withTenantDb, type Tx } from "@oxagen/database";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen/types";
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

/**
 * An admission is reported as needing reconciliation once it has sat this
 * long without complete usage. A stream still in flight is not a gap.
 */
export const USAGE_INCOMPLETE_GRACE_MS = 3_600_000;

/**
 * Incomplete admissions are counted only inside this window after admission.
 * A count over all time can only rise: an admission nobody will ever
 * reconcile stays in it for ever, and the alert it drives stops meaning
 * "something is wrong now". Older rows are still in the table for an audit.
 */
export const USAGE_INCOMPLETE_WINDOW_DAYS = 7;

/**
 * A delivered admission is kept this long after delivery. Its body is gone
 * at delivery; the row that remains is the fence that stops a late finalizer
 * from staging the same usage twice. Thirty days is past any stream that
 * could still be in flight and past the outbox's longest retry backoff.
 */
export const USAGE_OUTBOX_RETENTION_DAYS = 30;

/** At most this many delivered rows are swept per delivery pass. */
const USAGE_OUTBOX_SWEEP_BATCH = 1_000;

const DAY_MS = 86_400_000;

function assertUsageScope(orgId: string, workspaceId: string): void {
  const scope = requireScope();
  if (scope.orgId !== orgId || scope.workspaceId !== workspaceId)
    throw new Error("Usage scope differs from the active tenant.");
}

/**
 * The transaction an admission's own lifecycle runs in.
 *
 * A workspace-scoped admission runs under the tenant transaction, so RLS is
 * load-bearing for the admission row and for every ledger row `settle`
 * writes beside it. An organisation-only scope cannot: the workspace GUC is
 * a marker that makes every read of a workspace-scoped table refuse
 * (`isOrgOnlyWorkspaceReadRefusal`), and `usage_outbox` is one. Those
 * admissions stay on the system connection with the explicit org and
 * workspace predicates every query here carries.
 */
function admissionTransaction(workspaceId: string) {
  return workspaceId === ORG_ONLY_WORKSPACE_ID ? withSystemDb : withTenantDb;
}

/** Persist an admission before contacting the provider. Failure refuses the call. */
export async function admitUsage(
  orgId: string,
  workspaceId: string,
): Promise<string> {
  assertUsageScope(orgId, workspaceId);
  const id = randomUUID();
  // tenancy: orgId and workspaceId match the verified active scope before admission.
  await admissionTransaction(workspaceId)((tx) =>
    tx.insert(schema.usageOutbox).values({ id, orgId, workspaceId }),
  );
  return id;
}

/** Why an admission was closed without usage. Named in the log line. */
export type UsageVoidReason =
  /** The provider call failed before its first step reported usage. */
  | "provider_error_before_first_step"
  /** The caller aborted before the first step reported usage. */
  | "aborted_before_first_step"
  /** A single-shot provider call threw; there is no usage to stage. */
  | "provider_call_failed";

/**
 * Close an admission whose provider call ended before any usage was reported.
 *
 * Without this, such an admission stays `usage_complete = false` for ever and
 * the reconciliation count only rises. The row is marked complete with no
 * payload and a finalization instant, so delivery never selects it and the
 * count no longer does. The update is conditional on the row still being
 * empty, so a void racing a late usage report can never clobber a staged
 * payload; a voided row is then a no-op for `finalizeUsage`, which logs it.
 *
 * Returns true when this call closed the row.
 */
export async function voidUsage(args: {
  id: string;
  orgId: string;
  workspaceId: string;
  reason: UsageVoidReason;
}): Promise<boolean> {
  assertUsageScope(args.orgId, args.workspaceId);
  // tenancy: filtered by orgId and workspaceId after verified active tenant scope.
  const closed = await admissionTransaction(args.workspaceId)((tx) =>
    tx
      .update(schema.usageOutbox)
      .set({ usageComplete: true, finalizedAt: new Date() })
      .where(
        and(
          eq(schema.usageOutbox.id, args.id),
          eq(schema.usageOutbox.orgId, args.orgId),
          eq(schema.usageOutbox.workspaceId, args.workspaceId),
          isNull(schema.usageOutbox.payload),
          isNull(schema.usageOutbox.finalizedAt),
        ),
      )
      .returning({ id: schema.usageOutbox.id }),
  );
  if (closed.length === 0) {
    logger.warn(
      { usageId: args.id, reason: args.reason },
      "Usage admission was not voided: it already carries usage or a settlement",
    );
    return false;
  }
  logger.warn(
    { usageId: args.id, reason: args.reason },
    "Usage admission voided: the provider call ended before any usage was reported",
  );
  return true;
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
  const transaction = admissionTransaction(args.row.workspace_id);
  // tenancy: filtered by orgId and workspaceId after verified active tenant scope.
  await transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(schema.usageOutbox)
      .where(predicate)
      .for("update");
    if (!entry) throw new Error("Usage admission is missing.");
    if (
      entry.finalizedAt !== null &&
      entry.payload === null &&
      entry.deliveredAt === null
    ) {
      // Voided: the call was recorded as having reported nothing, and now it
      // reports something. The usage is not staged, because the row is closed;
      // the line is what an operator reconciles from. A delivered row also
      // carries no payload, and is told apart by its delivery instant.
      logger.error(
        { usageId: args.id, alert: "billing_usage_after_void" },
        "Usage reported for an admission that was already voided",
      );
      return;
    }
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
  await transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(schema.usageOutbox)
      .where(predicate)
      .for("update");
    if (!entry) throw new Error("Usage admission is missing.");
    await settle(tx, entry);
  });
}

/** Said once per process; the privilege does not change while it runs. */
let sweepUnprivilegedNoted = false;

/**
 * Delete delivered rows past the retention window, in one bounded batch.
 *
 * The delete needs a privilege the table's grant does not carry today
 * (`billing.usage_outbox` grants SELECT, INSERT and UPDATE to `oxagen_app`).
 * Rather than fail every minute until the grant lands, the pass asks
 * Postgres first and reports once when it cannot sweep.
 */
async function sweepDeliveredUsage(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - USAGE_OUTBOX_RETENTION_DAYS * DAY_MS);
  // tenancy: scheduled cross-tenant retention sweep over delivered
  // admissions on the shared plane; the delete is filtered to rows past the
  // window, and no request scope exists here.
  return withSystemDb(async (tx) => {
    const [privilege] = (await tx.execute(
      sql`select has_table_privilege(current_user, 'billing.usage_outbox', 'DELETE') as ok`,
    )) as unknown as Array<{ ok: boolean }>;
    if (privilege?.ok !== true) {
      if (!sweepUnprivilegedNoted) {
        sweepUnprivilegedNoted = true;
        logger.error(
          { alert: "billing_usage_outbox_sweep_unprivileged" },
          "Delivered usage admissions are not swept: the connection role cannot DELETE from billing.usage_outbox",
        );
      }
      return 0;
    }
    const expired = tx
      .select({ id: schema.usageOutbox.id })
      .from(schema.usageOutbox)
      .where(
        and(
          isNotNull(schema.usageOutbox.deliveredAt),
          lte(schema.usageOutbox.deliveredAt, cutoff),
        ),
      )
      .limit(USAGE_OUTBOX_SWEEP_BATCH);
    const swept = await tx
      .delete(schema.usageOutbox)
      .where(inArray(schema.usageOutbox.id, expired))
      .returning({ id: schema.usageOutbox.id });
    return swept.length;
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
  swept: number;
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
  const now = new Date();
  // tenancy: scheduled cross-tenant reconciliation counts incomplete shared-plane admissions globally.
  const [unknown] = await withSystemDb((tx) =>
    tx
      .select({ count: sql<number>`count(*)::integer` })
      .from(schema.usageOutbox)
      .where(
        and(
          eq(schema.usageOutbox.usageComplete, false),
          lte(
            schema.usageOutbox.admittedAt,
            new Date(now.getTime() - USAGE_INCOMPLETE_GRACE_MS),
          ),
          gte(
            schema.usageOutbox.admittedAt,
            new Date(now.getTime() - USAGE_INCOMPLETE_WINDOW_DAYS * DAY_MS),
          ),
        ),
      ),
  );
  const incomplete = unknown?.count ?? 0;
  if (incomplete > 0)
    logger.error(
      {
        incomplete,
        windowDays: USAGE_INCOMPLETE_WINDOW_DAYS,
        alert: "billing_usage_incomplete",
      },
      "Provider usage needs reconciliation",
    );
  const swept = await sweepDeliveredUsage(now);
  return { selected: pending.length, delivered, failed, incomplete, swept };
}
