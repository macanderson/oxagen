/**
 * payment-methods.ts — org payment-method management.
 *
 * All card data lives in Stripe; we keep a local DB mirror (billing.payment_methods)
 * for fast reads and audit. The source of truth for card details is always the
 * billing provider. The DB mirror is updated via syncPaymentMethodsFromStripe
 * which is called after SetupIntent success and at any point a caller needs a
 * fresh view.
 */

import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { billingProvider } from "./client";
import { ensureStripeCustomer } from "./customers";
import { logger } from "./logger";

// ── Public types ──────────────────────────────────────────────────────────────

export interface PaymentMethodView {
  stripePaymentMethodId: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
}

// ── Error types ───────────────────────────────────────────────────────────────

/**
 * Thrown when the caller tries to remove the last payment method on an org
 * that has an active subscription.
 */
export class LastPaymentMethodError extends Error {
  readonly code = "last_payment_method" as const;

  constructor() {
    super(
      "Cannot remove the last payment method while the org has an active subscription.",
    );
    this.name = "LastPaymentMethodError";
  }
}

/** Type guard. */
export function isLastPaymentMethodError(
  err: unknown,
): err is LastPaymentMethodError {
  return err instanceof LastPaymentMethodError;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Resolve or create a Stripe customer id for the org. */
async function resolveCustomerId(orgId: string): Promise<string> {
  // Prefer the customer id already recorded on a subscription row (fastest path).
  const sub = await withTenantDb((tx) =>
    tx.query.subscriptions.findFirst({
      where: eq(schema.subscriptions.orgId, orgId),
      columns: { stripeCustomerId: true },
    }),
  );
  if (sub?.stripeCustomerId) return sub.stripeCustomerId;
  // Fall back to ensureStripeCustomer which may create the customer.
  return ensureStripeCustomer(orgId);
}

// ── listOrgPaymentMethods ─────────────────────────────────────────────────────

/**
 * Return the org's non-deleted payment methods from the local DB mirror.
 * isDefault is read directly from the DB flag (kept in sync by
 * syncPaymentMethodsFromStripe).
 */
export async function listOrgPaymentMethods(
  orgId: string,
): Promise<PaymentMethodView[]> {
  const start = Date.now();

  const rows = await withTenantDb((tx) =>
    tx.query.paymentMethods.findMany({
      where: and(
        eq(schema.paymentMethods.orgId, orgId),
        isNull(schema.paymentMethods.deletedAt),
      ),
      columns: {
        stripePaymentMethodId: true,
        brand: true,
        last4: true,
        expMonth: true,
        expYear: true,
        isDefault: true,
      },
    }),
  );

  logger.debug(
    { orgId, count: rows.length, durationMs: Date.now() - start },
    "billing: listed org payment methods",
  );

  return rows.map((r) => ({
    stripePaymentMethodId: r.stripePaymentMethodId,
    brand: r.brand,
    last4: r.last4,
    expMonth: r.expMonth,
    expYear: r.expYear,
    isDefault: r.isDefault,
  }));
}

// ── createPaymentMethodSetupIntent ────────────────────────────────────────────

/**
 * Create a SetupIntent so the browser (Stripe.js / Elements) can collect and
 * save a new card without PAN ever touching our servers.
 *
 * After the browser confirms the SetupIntent, call syncPaymentMethodsFromStripe
 * to pull the newly attached card into the DB mirror.
 */
export async function createPaymentMethodSetupIntent(
  orgId: string,
): Promise<{ clientSecret: string }> {
  const start = Date.now();
  const customerId = await resolveCustomerId(orgId);
  const { clientSecret } =
    await billingProvider().createSetupIntent(customerId);

  logger.info(
    { orgId, customerId, durationMs: Date.now() - start },
    "billing: created SetupIntent for org",
  );

  return { clientSecret };
}

// ── syncPaymentMethodsFromStripe ──────────────────────────────────────────────

/**
 * Pull the customer's current payment methods from Stripe and upsert the local
 * DB mirror:
 *   - ON CONFLICT (stripe_payment_method_id) DO UPDATE to keep card details
 *     current (cards can expire or be updated by the network).
 *   - Set the isDefault flag on exactly one card (the Stripe default).
 *   - Soft-delete any DB rows for cards that Stripe no longer returns (detached
 *     by the customer in the Stripe dashboard or via another path).
 *
 * Call this after a SetupIntent succeeds or whenever a fresh view is needed.
 */
export async function syncPaymentMethodsFromStripe(
  orgId: string,
): Promise<void> {
  const start = Date.now();
  const customerId = await resolveCustomerId(orgId);
  const provider = billingProvider();

  const [providerMethods, defaultPmId] = await Promise.all([
    provider.listPaymentMethods(customerId),
    provider.getDefaultPaymentMethodId(customerId),
  ]);

  const providerIds = new Set(providerMethods.map((pm) => pm.id));

  // Batch-upsert all active cards from Stripe in a single transaction.
  if (providerMethods.length > 0) {
    await withTenantDb((tx) =>
      tx
        .insert(schema.paymentMethods)
        .values(
          providerMethods.map((pm) => ({
            orgId,
            stripeCustomerId: customerId,
            stripePaymentMethodId: pm.id,
            type: pm.type,
            brand: pm.brand,
            last4: pm.last4,
            expMonth: pm.expMonth,
            expYear: pm.expYear,
            isDefault: pm.id === defaultPmId,
            deletedAt: null,
            deletedByUserId: null,
          })),
        )
        .onConflictDoUpdate({
          target: schema.paymentMethods.stripePaymentMethodId,
          set: {
            type: sql`excluded.type`,
            brand: sql`excluded.brand`,
            last4: sql`excluded.last4`,
            expMonth: sql`excluded.exp_month`,
            expYear: sql`excluded.exp_year`,
            isDefault: sql`excluded.is_default`,
            deletedAt: null, // Un-soft-delete if it re-appears.
            deletedByUserId: null,
            updatedAt: new Date(),
          },
        }),
    );
  }

  // Ensure exactly one default row per org. Both writes run in ONE transaction
  // so a concurrent read never observes a window with zero defaults.
  if (defaultPmId) {
    await withTenantDb(async (tx) => {
      await tx
        .update(schema.paymentMethods)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(
          and(
            eq(schema.paymentMethods.orgId, orgId),
            isNull(schema.paymentMethods.deletedAt),
            eq(schema.paymentMethods.isDefault, true),
          ),
        );
      await tx
        .update(schema.paymentMethods)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(schema.paymentMethods.stripePaymentMethodId, defaultPmId));
    });
  }

  // Soft-delete rows for cards no longer returned by Stripe.
  const existingRows = await withTenantDb((tx) =>
    tx.query.paymentMethods.findMany({
      where: and(
        eq(schema.paymentMethods.orgId, orgId),
        isNull(schema.paymentMethods.deletedAt),
      ),
      columns: { id: true, stripePaymentMethodId: true },
    }),
  );

  const now = new Date();
  const staleIds = existingRows
    .filter((r) => !providerIds.has(r.stripePaymentMethodId))
    .map((r) => r.id);
  if (staleIds.length > 0) {
    await withTenantDb((tx) =>
      tx
        .update(schema.paymentMethods)
        .set({ deletedAt: now, updatedAt: now })
        .where(inArray(schema.paymentMethods.id, staleIds)),
    );
  }

  logger.info(
    {
      orgId,
      customerId,
      upserted: providerMethods.length,
      softDeleted: staleIds.length,
      durationMs: Date.now() - start,
    },
    "billing: synced payment methods from Stripe",
  );
}

// ── setOrgDefaultPaymentMethod ────────────────────────────────────────────────

/**
 * Set the org's default payment method.
 *
 * Calls the provider to update the Stripe customer default, then flips the
 * isDefault flag in the DB (one row true, all others false).
 */
export async function setOrgDefaultPaymentMethod(
  orgId: string,
  stripePaymentMethodId: string,
): Promise<void> {
  const start = Date.now();
  const customerId = await resolveCustomerId(orgId);

  await billingProvider().setDefaultPaymentMethod(
    customerId,
    stripePaymentMethodId,
  );

  // Flip the flags in ONE transaction so a concurrent read never observes a
  // window with zero defaults.
  await withTenantDb(async (tx) => {
    await tx
      .update(schema.paymentMethods)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(
        and(
          eq(schema.paymentMethods.orgId, orgId),
          isNull(schema.paymentMethods.deletedAt),
        ),
      );
    await tx
      .update(schema.paymentMethods)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(
        and(
          eq(
            schema.paymentMethods.stripePaymentMethodId,
            stripePaymentMethodId,
          ),
          eq(schema.paymentMethods.orgId, orgId),
        ),
      );
  });

  logger.info(
    { orgId, stripePaymentMethodId, durationMs: Date.now() - start },
    "billing: default payment method updated",
  );
}

// ── removeOrgPaymentMethod ────────────────────────────────────────────────────

/**
 * Remove a payment method from the org.
 *
 * Guard: if this is the LAST remaining payment method and the org has an active
 * subscription, the call is rejected with LastPaymentMethodError. Removing
 * the only card on an active sub would break auto-renewal.
 *
 * On success:
 *   - Calls provider.detachPaymentMethod to remove it from Stripe.
 *   - Soft-deletes the DB row.
 *   - If this card was the default, promotes the lexicographically first
 *     remaining card to default (or leaves isDefault=false if none remain).
 */
export async function removeOrgPaymentMethod(
  orgId: string,
  stripePaymentMethodId: string,
): Promise<void> {
  const start = Date.now();

  // Load current non-deleted rows for this org.
  const allRows = await withTenantDb((tx) =>
    tx.query.paymentMethods.findMany({
      where: and(
        eq(schema.paymentMethods.orgId, orgId),
        isNull(schema.paymentMethods.deletedAt),
      ),
      columns: {
        id: true,
        stripePaymentMethodId: true,
        isDefault: true,
      },
    }),
  );

  // Verify the card belongs to this org.
  const target = allRows.find(
    (r) => r.stripePaymentMethodId === stripePaymentMethodId,
  );
  if (!target) {
    throw new Error(
      `billing: payment method ${stripePaymentMethodId} not found for org ${orgId}`,
    );
  }

  // Guard: refuse to remove the last card when an active subscription exists.
  if (allRows.length <= 1) {
    const { activeSub, trialSub } = await withTenantDb(async (tx) => {
      const active = await tx.query.subscriptions.findFirst({
        where: and(
          eq(schema.subscriptions.orgId, orgId),
          eq(schema.subscriptions.status, "active"),
        ),
        columns: { id: true },
      });
      // Also check trialing.
      const trial = active
        ? null
        : await tx.query.subscriptions.findFirst({
            where: and(
              eq(schema.subscriptions.orgId, orgId),
              eq(schema.subscriptions.status, "trialing"),
            ),
            columns: { id: true },
          });
      return { activeSub: active, trialSub: trial };
    });

    if (activeSub ?? trialSub) {
      throw new LastPaymentMethodError();
    }
  }

  const wasDefault = target.isDefault;

  // Detach from Stripe.
  await billingProvider().detachPaymentMethod(stripePaymentMethodId);

  // Soft-delete the DB row.
  const now = new Date();
  await withTenantDb((tx) =>
    tx
      .update(schema.paymentMethods)
      .set({ deletedAt: now, isDefault: false, updatedAt: now })
      .where(
        and(
          eq(
            schema.paymentMethods.stripePaymentMethodId,
            stripePaymentMethodId,
          ),
          eq(schema.paymentMethods.orgId, orgId),
        ),
      ),
  );

  // If this was the default, promote another card.
  if (wasDefault) {
    const remaining = allRows.filter(
      (r) => r.stripePaymentMethodId !== stripePaymentMethodId,
    );
    if (remaining.length > 0) {
      const next = remaining[0]!;
      const customerId = await resolveCustomerId(orgId);
      // Promote next card to default in Stripe and in the DB mirror.
      // If this fails the org will have zero cards with isDefault: true in the DB,
      // disabling auto-reload and any default-card-dependent billing path silently.
      // We must propagate the error so the caller knows the default state is inconsistent
      // and can trigger a re-sync (syncPaymentMethodsFromStripe) to recover.
      try {
        await billingProvider().setDefaultPaymentMethod(
          customerId,
          next.stripePaymentMethodId,
        );
        await withTenantDb((tx) =>
          tx
            .update(schema.paymentMethods)
            .set({ isDefault: true, updatedAt: new Date() })
            .where(eq(schema.paymentMethods.id, next.id)),
        );
        logger.info(
          {
            orgId,
            newDefaultPmId: next.stripePaymentMethodId,
          },
          "billing: promoted next card to default after removal",
        );
      } catch (err) {
        // Log with the full context needed to diagnose and manually recover.
        // The removed card has already been detached from Stripe; the org now has
        // zero cards marked isDefault in the DB. Re-throw so the caller surfaces
        // the failure and can trigger syncPaymentMethodsFromStripe to repair state.
        logger.error(
          { orgId, failedPmId: next.stripePaymentMethodId, err },
          "billing: failed to promote next card to default after removal — DB default state is inconsistent; caller must re-sync",
        );
        throw err;
      }
    }
  }

  logger.info(
    {
      orgId,
      stripePaymentMethodId,
      wasDefault,
      durationMs: Date.now() - start,
    },
    "billing: payment method removed",
  );
}
