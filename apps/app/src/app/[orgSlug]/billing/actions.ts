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
 * Shared authorization gate for every mutating billing action.
 *
 * Resolves the org AND asserts the caller (a) is a member of that org and
 * (b) holds a billing-management role (owner/admin/billing). Returns the
 * org id on success, or `null` when the caller lacks rights — which also
 * closes the cross-org IDOR (a member of org A cannot pass org B's slug,
 * since the orgUsers lookup is keyed on (tenant.id, session.user.id) and a
 * non-member yields no row). `getSessionOrRedirect` still redirects an
 * unauthenticated caller before we get here.
 */
async function resolveManagedOrg(orgSlug: string): Promise<{ orgId: string } | null> {
  const session = await getSessionOrRedirect();
  const tenant = await resolveOrg(orgSlug);
  if (!session.user) return null;

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
  const role = row?.role ?? null;
  if (!role || !CAN_MANAGE_BILLING.has(role)) {
    logger.warn({ orgSlug, userId: session.user.id, role }, "billing: action denied — not a billing manager");
    return null;
  }
  return { orgId: tenant.id };
}

/** Standard unauthorized message for billing-management actions. */
const NOT_AUTHORIZED = "You don't have permission to manage billing for this organization.";

// ── cancelSubscriptionAction ─────────────────────────────────────────────────

export async function cancelSubscriptionAction(input: {
  orgSlug: string;
}): Promise<{ ok: boolean; error?: string }> {
  const managed = await resolveManagedOrg(input.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  try {
    await cancelOrgSubscription(managed.orgId);
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
  const managed = await resolveManagedOrg(input.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  try {
    await reactivateOrgSubscription(managed.orgId);
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
  const parsed = ChangePlanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, targetPlanSlug, interval } = parsed.data;
  const managed = await resolveManagedOrg(orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  const env = loadEnv();

  try {
    const result = await changeOrgPlan(managed.orgId, targetPlanSlug, interval, {
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
  const parsed = SetSeatsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "internal", error: "Invalid input" };
  }

  const { orgSlug, seats } = parsed.data;
  const managed = await resolveManagedOrg(orgSlug);
  if (!managed) return { ok: false, code: "internal", error: NOT_AUTHORIZED };

  try {
    await setSubscriptionSeats(managed.orgId, seats);
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
  const parsed = BuyCreditsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug, amountUsd } = parsed.data;
  const managed = await resolveManagedOrg(orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
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
  const parsed = PreviewSeatsSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid input" };

  const { orgSlug, seats } = parsed.data;
  const managed = await resolveManagedOrg(orgSlug);
  if (!managed) return { error: NOT_AUTHORIZED };

  try {
    const preview = await previewSeatChange(managed.orgId, seats);
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
  const parsed = PreviewPlanSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid input" };

  const { orgSlug, targetPlanSlug, interval } = parsed.data;
  const managed = await resolveManagedOrg(orgSlug);
  if (!managed) return { error: NOT_AUTHORIZED };

  try {
    const preview = await previewPlanChange(managed.orgId, targetPlanSlug, interval);
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
  const parsed = OrgSlugSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const { orgSlug } = parsed.data;
  const managed = await resolveManagedOrg(orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };

  try {
    const { clientSecret } = await createPaymentMethodSetupIntent(managed.orgId);
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
  const parsed = OrgSlugSchema.safeParse(input);
  if (!parsed.success) return { ok: false };

  const { orgSlug } = parsed.data;
  const managed = await resolveManagedOrg(orgSlug);
  if (!managed) return { ok: false };

  try {
    await syncPaymentMethodsFromStripe(managed.orgId);
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
  const parsed = PaymentMethodSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid input" };

  const { orgSlug, paymentMethodId } = parsed.data;
  const managed = await resolveManagedOrg(orgSlug);
  if (!managed) return { error: NOT_AUTHORIZED };

  try {
    await setOrgDefaultPaymentMethod(managed.orgId, paymentMethodId);
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
  const parsed = PaymentMethodSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid input" };

  const { orgSlug, paymentMethodId } = parsed.data;
  const managed = await resolveManagedOrg(orgSlug);
  if (!managed) return { error: NOT_AUTHORIZED };

  try {
    await removeOrgPaymentMethod(managed.orgId, paymentMethodId);
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
  const parsed = UpdateAutoReloadSchema.safeParse(input);
  if (!parsed.success) return { error: "Invalid input" };

  const { orgSlug, ...updates } = parsed.data;
  const managed = await resolveManagedOrg(orgSlug);
  if (!managed) return { error: NOT_AUTHORIZED };

  try {
    const settings = await updateAutoReloadSettings(managed.orgId, updates);
    revalidatePath(`/${orgSlug}/billing/subscription`);
    logger.info({ orgSlug }, "billing: updateAutoReloadAction");
    return { ok: true, settings };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update auto-reload";
    logger.error({ err, orgSlug }, "billing: updateAutoReloadAction failed");
    return { error: message };
  }
}
