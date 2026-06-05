"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import {
  cancelOrgSubscription,
  reactivateOrgSubscription,
  changeOrgPlan,
  setSubscriptionSeats,
  isSeatLimitError,
  previewSeatChange,
  previewPlanChange,
  createPaymentMethodSetupIntent,
  syncPaymentMethodsFromStripe,
  setOrgDefaultPaymentMethod,
  removeOrgPaymentMethod,
  updateAutoReloadSettings,
} from "@oxagen/billing";
import type {
  SeatChangePreview,
  PlanChangePreview,
  OrgBillingSettings,
} from "@oxagen/billing";
import { loadEnv } from "@oxagen/config/env";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";
import { logger } from "@oxagen/handlers/logger";

const CAN_MANAGE_BILLING = new Set(["owner", "admin", "billing"]);

// ── resolveOrgWithBillingGate ─────────────────────────────────────────────────

/**
 * Shared guard: resolve org + assert the calling user has billing-management
 * rights. Returns the resolved tenant. Throws a redirect if not authed, or
 * returns `null` if the caller lacks the required role.
 *
 * Exported for testing only — prefer the individual action functions in
 * application code.
 */
async function resolveManagedOrg(orgSlug: string) {
  const session = await getSessionOrRedirect();
  const tenant = await resolveOrg(orgSlug);

  if (session.user) {
    const { db, schema } = await import("@oxagen/database");
    const { eq, and } = await import("drizzle-orm");
    const [row] = await db()
      .select({ role: schema.orgUsers.role })
      .from(schema.orgUsers)
      .where(
        and(
          eq(schema.orgUsers.orgId, tenant.id),
          eq(schema.orgUsers.userId, session.user.id),
        ),
      )
      .limit(1);
    const role = row?.role ?? "member";
    if (!CAN_MANAGE_BILLING.has(role)) {
      return { tenant: null as never, orgId: "" };
    }
  }

  return { tenant, orgId: tenant.id };
}

// ── cancelSubscriptionAction ─────────────────────────────────────────────────

export async function cancelSubscriptionAction(input: {
  orgSlug: string;
}): Promise<{ ok: boolean; error?: string }> {
  await getSessionOrRedirect();
  const tenant = await resolveOrg(input.orgSlug);
  try {
    await cancelOrgSubscription(tenant.id);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Cancel failed" };
  }
  revalidatePath(`/${input.orgSlug}/billing`);
  revalidatePath(`/${input.orgSlug}/billing/subscription`);
  return { ok: true };
}

// ── reactivateSubscriptionAction ─────────────────────────────────────────────

export async function reactivateSubscriptionAction(input: {
  orgSlug: string;
}): Promise<{ ok: boolean; error?: string }> {
  await getSessionOrRedirect();
  const tenant = await resolveOrg(input.orgSlug);
  try {
    await reactivateOrgSubscription(tenant.id);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Reactivate failed" };
  }
  revalidatePath(`/${input.orgSlug}/billing`);
  revalidatePath(`/${input.orgSlug}/billing/subscription`);
  return { ok: true };
}

// ── changePlanAction ──────────────────────────────────────────────────────────

const ChangePlanSchema = z.object({
  orgSlug: z.string().min(1),
  targetPlanSlug: z.string().min(1),
  interval: z.enum(["month", "year"]),
});

/**
 * Switch to any plan (upgrade, downgrade, or same tier).
 * - If the org has no active subscription → returns a Stripe checkout URL.
 * - If it does → swaps price in-place and revalidates (returns null url).
 */
export async function changePlanAction(
  input: z.infer<typeof ChangePlanSchema>,
): Promise<{ ok: true; url: string | null } | { ok: false; error: string }> {
  await getSessionOrRedirect();
  const parsed = ChangePlanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, targetPlanSlug, interval } = parsed.data;
  const env = loadEnv();
  const tenant = await resolveOrg(orgSlug);

  try {
    const result = await changeOrgPlan(tenant.id, targetPlanSlug, interval, {
      successUrl: `${env.NEXT_PUBLIC_APP_URL}/${orgSlug}/billing/subscription?status=success`,
      cancelUrl: `${env.NEXT_PUBLIC_APP_URL}/${orgSlug}/billing/subscription?status=canceled`,
    });

    if (result === null) {
      // In-place swap — revalidate and let the client know no redirect is needed.
      revalidatePath(`/${orgSlug}/billing`);
      revalidatePath(`/${orgSlug}/billing/subscription`);
      logger.info({ orgSlug, targetPlanSlug, interval }, "billing: plan swapped in-place");
      return { ok: true, url: null };
    }

    // New checkout session — redirect.
    logger.info({ orgSlug, targetPlanSlug, interval }, "billing: plan change → Stripe checkout");
    return { ok: true, url: result.checkoutUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Plan change failed";
    logger.error({ err, orgSlug, targetPlanSlug }, "billing: changePlanAction failed");
    return { ok: false, error: message };
  }
}

// ── setSeatsAction ────────────────────────────────────────────────────────────

const SetSeatsSchema = z.object({
  orgSlug: z.string().min(1),
  seats: z.number().int().min(1),
});

export type SetSeatsResult =
  | { ok: true }
  | { ok: false; code: "seat_limit_reached"; licenses: number; used: number; error: string }
  | { ok: false; code: "internal"; error: string };

export async function setSeatsAction(
  input: z.infer<typeof SetSeatsSchema>,
): Promise<SetSeatsResult> {
  await getSessionOrRedirect();
  const parsed = SetSeatsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "internal", error: "Invalid input" };
  }

  const { orgSlug, seats } = parsed.data;
  const tenant = await resolveOrg(orgSlug);

  try {
    await setSubscriptionSeats(tenant.id, seats);
    revalidatePath(`/${orgSlug}/billing`);
    revalidatePath(`/${orgSlug}/billing/subscription`);
    logger.info({ orgSlug, seats }, "billing: seats updated");
    return { ok: true };
  } catch (err) {
    if (isSeatLimitError(err)) {
      return {
        ok: false,
        code: "seat_limit_reached",
        licenses: err.licenses,
        used: err.used,
        error: err.message,
      };
    }
    const message = err instanceof Error ? err.message : "Failed to update seats";
    logger.error({ err, orgSlug, seats }, "billing: setSeatsAction failed");
    return { ok: false, code: "internal", error: message };
  }
}

// ── buyCreditsAction ──────────────────────────────────────────────────────────

const BuyCreditsSchema = z.object({
  orgSlug: z.string().min(1),
  /** Dollar amount (face value) the customer wants, e.g. 50 for $50. Min $5. */
  amountUsd: z.number().positive().min(5),
});

/**
 * Start a Stripe Checkout session for usage-credit purchase.
 * Returns the Stripe checkout URL to redirect the browser to.
 */
export async function buyCreditsAction(
  input: z.infer<typeof BuyCreditsSchema>,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  await getSessionOrRedirect();
  const parsed = BuyCreditsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, amountUsd } = parsed.data;
  const env = loadEnv();

  try {
    const res = await fetch(`${env.NEXT_PUBLIC_APP_URL}/api/v1/stripe/credits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgSlug, amountUsd }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: text || "Credits checkout failed" };
    }
    const json = (await res.json()) as { url: string };
    return { ok: true, url: json.url };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Credits checkout failed";
    logger.error({ err, orgSlug, amountUsd }, "billing: buyCreditsAction failed");
    return { ok: false, error: message };
  }
}

// ── previewSeatsAction ────────────────────────────────────────────────────────

const PreviewSeatsSchema = z.object({
  orgSlug: z.string().min(1),
  seats: z.number().int().min(1),
});

export async function previewSeatsAction(
  input: z.infer<typeof PreviewSeatsSchema>,
): Promise<SeatChangePreview | { error: string }> {
  await getSessionOrRedirect();
  const parsed = PreviewSeatsSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid input" };

  const { orgSlug, seats } = parsed.data;
  const tenant = await resolveOrg(orgSlug);

  try {
    const preview = await previewSeatChange(tenant.id, seats);
    logger.info({ orgSlug, seats }, "billing: previewSeatsAction");
    return preview;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Preview failed";
    logger.error({ err, orgSlug, seats }, "billing: previewSeatsAction failed");
    return { error: message };
  }
}

// ── previewPlanAction ─────────────────────────────────────────────────────────

const PreviewPlanSchema = z.object({
  orgSlug: z.string().min(1),
  targetPlanSlug: z.string().min(1),
  interval: z.enum(["month", "year"]),
});

export async function previewPlanAction(
  input: z.infer<typeof PreviewPlanSchema>,
): Promise<PlanChangePreview | { error: string }> {
  await getSessionOrRedirect();
  const parsed = PreviewPlanSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid input" };

  const { orgSlug, targetPlanSlug, interval } = parsed.data;
  const tenant = await resolveOrg(orgSlug);

  try {
    const preview = await previewPlanChange(tenant.id, targetPlanSlug, interval);
    logger.info({ orgSlug, targetPlanSlug, interval }, "billing: previewPlanAction");
    return preview;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Preview failed";
    logger.error({ err, orgSlug, targetPlanSlug }, "billing: previewPlanAction failed");
    return { error: message };
  }
}

// ── createSetupIntentAction ───────────────────────────────────────────────────

const OrgSlugSchema = z.object({ orgSlug: z.string().min(1) });

export async function createSetupIntentAction(input: {
  orgSlug: string;
}): Promise<{ ok: true; clientSecret: string } | { ok: false; error: string }> {
  await getSessionOrRedirect();
  const parsed = OrgSlugSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug } = parsed.data;
  const tenant = await resolveOrg(orgSlug);

  try {
    const { clientSecret } = await createPaymentMethodSetupIntent(tenant.id);
    logger.info({ orgSlug }, "billing: createSetupIntentAction");
    return { ok: true, clientSecret };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Setup intent failed";
    logger.error({ err, orgSlug }, "billing: createSetupIntentAction failed");
    return { ok: false, error: message };
  }
}

// ── syncPaymentMethodsAction ──────────────────────────────────────────────────

export async function syncPaymentMethodsAction(input: {
  orgSlug: string;
}): Promise<{ ok: boolean }> {
  await getSessionOrRedirect();
  const parsed = OrgSlugSchema.safeParse(input);
  if (!parsed.success) return { ok: false };

  const { orgSlug } = parsed.data;
  const tenant = await resolveOrg(orgSlug);

  try {
    await syncPaymentMethodsFromStripe(tenant.id);
    revalidatePath(`/${orgSlug}/billing/subscription`);
    logger.info({ orgSlug }, "billing: syncPaymentMethodsAction");
    return { ok: true };
  } catch (err) {
    logger.error({ err, orgSlug }, "billing: syncPaymentMethodsAction failed");
    return { ok: false };
  }
}

// ── setDefaultPaymentMethodAction ─────────────────────────────────────────────

const PaymentMethodSchema = z.object({
  orgSlug: z.string().min(1),
  paymentMethodId: z.string().min(1),
});

export async function setDefaultPaymentMethodAction(input: {
  orgSlug: string;
  paymentMethodId: string;
}): Promise<{ ok: true } | { error: string }> {
  await getSessionOrRedirect();
  const parsed = PaymentMethodSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid input" };

  const { orgSlug, paymentMethodId } = parsed.data;
  const tenant = await resolveOrg(orgSlug);

  try {
    await setOrgDefaultPaymentMethod(tenant.id, paymentMethodId);
    revalidatePath(`/${orgSlug}/billing/subscription`);
    logger.info({ orgSlug, paymentMethodId }, "billing: setDefaultPaymentMethodAction");
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to set default";
    logger.error({ err, orgSlug, paymentMethodId }, "billing: setDefaultPaymentMethodAction failed");
    return { error: message };
  }
}

// ── removePaymentMethodAction ─────────────────────────────────────────────────

export async function removePaymentMethodAction(input: {
  orgSlug: string;
  paymentMethodId: string;
}): Promise<{ ok: true } | { error: string; code?: string }> {
  await getSessionOrRedirect();
  const parsed = PaymentMethodSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid input" };

  const { orgSlug, paymentMethodId } = parsed.data;
  const tenant = await resolveOrg(orgSlug);

  try {
    await removeOrgPaymentMethod(tenant.id, paymentMethodId);
    revalidatePath(`/${orgSlug}/billing/subscription`);
    logger.info({ orgSlug, paymentMethodId }, "billing: removePaymentMethodAction");
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to remove payment method";
    logger.error({ err, orgSlug, paymentMethodId }, "billing: removePaymentMethodAction failed");
    return { error: message };
  }
}

// ── updateAutoReloadAction ────────────────────────────────────────────────────

const UpdateAutoReloadSchema = z.object({
  orgSlug: z.string().min(1),
  enabled: z.boolean().optional(),
  thresholdCents: z.number().int().min(0).optional(),
  amountCents: z.number().int().min(0).optional(),
  paymentMethodId: z.string().optional(),
});

export async function updateAutoReloadAction(input: {
  orgSlug: string;
  enabled?: boolean;
  thresholdCents?: number;
  amountCents?: number;
  paymentMethodId?: string;
}): Promise<{ ok: true; settings: OrgBillingSettings } | { error: string }> {
  await getSessionOrRedirect();
  const parsed = UpdateAutoReloadSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid input" };

  const { orgSlug, ...updates } = parsed.data;
  const tenant = await resolveOrg(orgSlug);

  try {
    const settings = await updateAutoReloadSettings(tenant.id, updates);
    revalidatePath(`/${orgSlug}/billing/subscription`);
    logger.info({ orgSlug }, "billing: updateAutoReloadAction");
    return { ok: true, settings };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update auto-reload";
    logger.error({ err, orgSlug }, "billing: updateAutoReloadAction failed");
    return { error: message };
  }
}
