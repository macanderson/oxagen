import { withTenantDb, withSystemDb, schema } from "@oxagen/database";
import type { Tx } from "@oxagen/database";
import { and, eq, lt, sql } from "drizzle-orm";
import { logger } from "./logger";
import type { BillingInvoice } from "./provider";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DUNNING_GRACE_DAYS = 7;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class BillingSuspendedError extends Error {
  readonly code = "billing_suspended" as const;
  readonly graceEndsAt: Date | null;

  constructor(graceEndsAt: Date | null) {
    super(
      graceEndsAt
        ? `Billing suspended (grace period ended at ${graceEndsAt.toISOString()})`
        : "Billing suspended",
    );
    this.name = "BillingSuspendedError";
    this.graceEndsAt = graceEndsAt;
  }
}

export function isBillingSuspended(e: unknown): e is BillingSuspendedError {
  return e instanceof BillingSuspendedError;
}

// ---------------------------------------------------------------------------
// Status read
// ---------------------------------------------------------------------------

export interface OrgBillingStatus {
  state: "active" | "grace" | "suspended";
  delinquentSince: Date | null;
  graceEndsAt: Date | null;
  suspendedAt: Date | null;
  pastDue: boolean;
}

/**
 * Read the org's current billing status from org_billing_settings and active
 * subscription row. The subscription's `past_due` status drives `pastDue`.
 */
export async function getOrgBillingStatus(orgId: string): Promise<OrgBillingStatus> {
  const [settings, sub] = await withTenantDb(async (tx) =>
    Promise.all([
      tx.query.orgBillingSettings.findFirst({
        where: eq(schema.orgBillingSettings.orgId, orgId),
        columns: {
          dunningState: true,
          delinquentSince: true,
          graceEndsAt: true,
          suspendedAt: true,
        },
      }),
      tx.query.subscriptions.findFirst({
        where: and(
          eq(schema.subscriptions.orgId, orgId),
          sql`${schema.subscriptions.status} IN ('active','trialing','past_due')`,
        ),
        columns: { status: true },
      }),
    ]),
  );

  const state = (settings?.dunningState ?? "active") as "active" | "grace" | "suspended";
  return {
    state,
    delinquentSince: settings?.delinquentSince ?? null,
    graceEndsAt: settings?.graceEndsAt ?? null,
    suspendedAt: settings?.suspendedAt ?? null,
    pastDue: sub?.status === "past_due",
  };
}

// ---------------------------------------------------------------------------
// Admission assert
// ---------------------------------------------------------------------------

/**
 * Throws `BillingSuspendedError` when the org's dunning state is 'suspended'.
 * Called by the pre-turn admission gate.
 */
export async function assertOrgCanConsume(orgId: string): Promise<void> {
  const status = await getOrgBillingStatus(orgId);
  if (status.state === "suspended") {
    throw new BillingSuspendedError(status.graceEndsAt);
  }
}

// ---------------------------------------------------------------------------
// Invoice lifecycle handlers
// ---------------------------------------------------------------------------

/**
 * Resolve the orgId from an invoice (via orgId field or subscription lookup).
 * Returns null when it cannot be resolved.
 *
 * tenancy: system bypass via withSystemDb (resolves org from external Stripe invoice id
 * before a tenant scope exists) — OXA-1515.
 */
async function resolveOrgFromInvoice(tx: Tx, invoice: BillingInvoice): Promise<string | null> {
  if (invoice.orgId) return invoice.orgId;

  if (invoice.subscriptionId) {
    const row = await tx.query.subscriptions.findFirst({
      where: eq(schema.subscriptions.stripeSubscriptionId, invoice.subscriptionId),
      columns: { orgId: true },
    });
    return row?.orgId ?? null;
  }

  return null;
}

/**
 * Called when an invoice.payment_failed event fires.
 *
 * Idempotent: sets dunningState → 'grace', delinquentSince (if not already
 * set), and graceEndsAt = now + DUNNING_GRACE_DAYS.
 */
export async function onInvoicePaymentFailed(invoice: BillingInvoice): Promise<void> {
  const start = Date.now();

  await withSystemDb(async (tx) => {
    // tenancy: system bypass via withSystemDb (org resolved from Stripe invoice, no workspace
    // context; billing is org_only; webhook path with no tenant scope) — OXA-1515
    const orgId = await resolveOrgFromInvoice(tx, invoice);
    if (!orgId) {
      logger.warn({ invoiceId: invoice.providerInvoiceId }, "billing: dunning — could not resolve orgId from invoice");
      return;
    }

    const now = new Date();
    const graceEndsAt = new Date(now.getTime() + DUNNING_GRACE_DAYS * 24 * 60 * 60 * 1000);

    // Upsert settings row: set grace state idempotently. Only set delinquentSince
    // the FIRST time (i.e. if it's already set, preserve the original timestamp).
    const existing = await tx.query.orgBillingSettings.findFirst({
      where: eq(schema.orgBillingSettings.orgId, orgId),
      columns: { id: true, delinquentSince: true, dunningState: true },
    });

    if (existing) {
      await tx
        .update(schema.orgBillingSettings)
        .set({
          dunningState: "grace",
          delinquentSince: existing.delinquentSince ?? now,
          graceEndsAt,
          updatedAt: now,
        })
        .where(eq(schema.orgBillingSettings.orgId, orgId));
    } else {
      // No settings row yet — insert one.
      await tx.insert(schema.orgBillingSettings).values({
        orgId,
        dunningState: "grace",
        delinquentSince: now,
        graceEndsAt,
      });
    }

    logger.info(
      {
        orgId,
        invoiceId: invoice.providerInvoiceId,
        graceEndsAt,
        durationMs: Date.now() - start,
      },
      "billing: dunning — entered grace period after payment failure",
    );
  });
}

/**
 * Called when an invoice.paid event fires.
 *
 * Resets dunning state to 'active' and clears delinquentSince, graceEndsAt,
 * and suspendedAt — full recovery.
 */
export async function onInvoiceRecovered(invoice: BillingInvoice): Promise<void> {
  const start = Date.now();

  await withSystemDb(async (tx) => {
    // tenancy: system bypass via withSystemDb (org resolved from Stripe invoice, no workspace
    // context; billing is org_only; webhook path with no tenant scope) — OXA-1515
    const orgId = await resolveOrgFromInvoice(tx, invoice);
    if (!orgId) {
      logger.warn({ invoiceId: invoice.providerInvoiceId }, "billing: dunning — could not resolve orgId for recovery");
      return;
    }

    const now = new Date();

    const existing = await tx.query.orgBillingSettings.findFirst({
      where: eq(schema.orgBillingSettings.orgId, orgId),
      columns: { id: true, dunningState: true },
    });

    // Only bother updating if the org was actually in a non-active state.
    if (!existing || existing.dunningState === "active") {
      logger.debug({ orgId, invoiceId: invoice.providerInvoiceId }, "billing: dunning — already active, skipping recovery");
      return;
    }

    await tx
      .update(schema.orgBillingSettings)
      .set({
        dunningState: "active",
        delinquentSince: null,
        graceEndsAt: null,
        suspendedAt: null,
        updatedAt: now,
      })
      .where(eq(schema.orgBillingSettings.orgId, orgId));

    logger.info(
      { orgId, invoiceId: invoice.providerInvoiceId, durationMs: Date.now() - start },
      "billing: dunning — recovered to active after invoice paid",
    );
  });
}

// ---------------------------------------------------------------------------
// Sweep: grace → suspended
// ---------------------------------------------------------------------------

/**
 * Sweep all orgs in grace where graceEndsAt < now → set 'suspended'.
 * Designed to be called from a daily scheduled job (`billingDunningSweep`
 * in packages/inngest-functions).
 */
export async function sweepDunning(): Promise<{ suspended: number }> {
  const start = Date.now();
  const now = new Date();

  return withSystemDb(async (tx) => {
    // tenancy: system bypass via withSystemDb (scheduled cron sweeps all orgs,
    // no per-org scope; billing is org_only) — OXA-1515
    const toSuspend = await tx.query.orgBillingSettings.findMany({
      where: and(
        eq(schema.orgBillingSettings.dunningState, "grace"),
        lt(schema.orgBillingSettings.graceEndsAt, now),
      ),
      columns: { id: true, orgId: true, graceEndsAt: true },
    });

    if (toSuspend.length === 0) {
      logger.info({ durationMs: Date.now() - start }, "billing: dunning sweep — no orgs to suspend");
      return { suspended: 0 };
    }

    let suspended = 0;
    for (const row of toSuspend) {
      await tx
        .update(schema.orgBillingSettings)
        .set({
          dunningState: "suspended",
          suspendedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.orgBillingSettings.id, row.id));
      suspended++;
      logger.warn(
        { orgId: row.orgId, graceEndsAt: row.graceEndsAt },
        "billing: dunning sweep — org suspended (grace period elapsed)",
      );
    }

    logger.info({ suspended, durationMs: Date.now() - start }, "billing: dunning sweep complete");
    return { suspended };
  });
}
