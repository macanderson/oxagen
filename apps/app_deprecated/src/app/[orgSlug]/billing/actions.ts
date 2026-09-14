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
  createUsageCreditCheckout,
  isTierDenied,
} from "@oxagen/billing";
import { runInTenantScope } from "@oxagen/tenancy";
import type {
  SeatChangePreview,
  PlanChangePreview,
  OrgBillingSettings,
} from "@oxagen/billing";
import { requireEnv } from "@oxagen/config/env";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";
import { logger } from "@oxagen/handlers/logger";
import { emitSecurityEvent } from "@oxagen/database/security";

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
// Sentinel workspaceId for org-only billing actions (no workspace context).
// Billing tables use an org_only policy class — the workspace GUC is set but
// not evaluated by RLS.
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

async function resolveManagedOrg(
  orgSlug: string,
): Promise<{ orgId: string; actorUserId: string } | null> {
  const session = await getSessionOrRedirect();
  const tenant = await resolveOrg(orgSlug);
  if (!session.user) return null;

  const { withTenantDb, schema } = await import("@oxagen/database");
  const { eq, and } = await import("drizzle-orm");
  const [row] = await runInTenantScope(
    { orgId: tenant.id, workspaceId: ORG_ONLY_WS },
    () =>
      withTenantDb((tx) =>
        tx
          .select({ role: schema.orgUsers.role })
          .from(schema.orgUsers)
          .where(
            and(
              eq(schema.orgUsers.orgId, tenant.id),
              eq(schema.orgUsers.userId, session.user.id),
            ),
          )
          .limit(1),
      ),
  );
  const role = row?.role ?? null;
  if (!role || !CAN_MANAGE_BILLING.has(role)) {
    logger.warn(
      { orgSlug, userId: session.user.id, role },
      "billing: action denied — not a billing manager",
    );
    // Emit billing.access_denied audit row (fire-and-forget; must not fail the
    // gate itself). orgId is always available at this point (resolveOrg succeeded).
    emitSecurityEvent({
      eventType: "billing.access_denied",
      actorUserId: session.user.id,
      orgId: tenant.id,
      workspaceId: null,
      capability: "billing.manage",
      outcome: "deny",
      ip: null,
      userAgent: null,
      requestId: null,
    });
    return null;
  }
  return { orgId: tenant.id, actorUserId: session.user.id };
}

/** Standard unauthorized message for billing-management actions. */
const NOT_AUTHORIZED =
  "You don't have permission to manage billing for this organization.";

// ── cancelSubscriptionAction ─────────────────────────────────────────────────

export async function cancelSubscriptionAction(input: {
  orgSlug: string;
}): Promise<{ ok: boolean; error?: string }> {
  const managed = await resolveManagedOrg(input.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  try {
    await runInTenantScope(
      { orgId: managed.orgId, workspaceId: ORG_ONLY_WS },
      () => cancelOrgSubscription(managed.orgId),
    );
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Cancel failed",
    };
  }
  revalidatePath(`/${input.orgSlug}/billing`);
  revalidatePath(`/${input.orgSlug}/billing/subscription`);
  emitSecurityEvent({
    eventType: "billing.subscription_canceled",
    actorUserId: managed.actorUserId,
    orgId: managed.orgId,
    workspaceId: null,
    capability: "billing.subscription.cancel",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: null,
  });
  return { ok: true };
}

// ── reactivateSubscriptionAction ─────────────────────────────────────────────

export async function reactivateSubscriptionAction(input: {
  orgSlug: string;
}): Promise<{ ok: boolean; error?: string }> {
  const managed = await resolveManagedOrg(input.orgSlug);
  if (!managed) return { ok: false, error: NOT_AUTHORIZED };
  try {
    await runInTenantScope(
      { orgId: managed.orgId, workspaceId: ORG_ONLY_WS },
      () => reactivateOrgSubscription(managed.orgId),
    );
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Reactivate failed",
    };
  }
  revalidatePath(`/${input.orgSlug}/billing`);
  revalidatePath(`/${input.orgSlug}/billing/subscription`);
  emitSecurityEvent({
    eventType: "billing.subscription_reactivated",
    actorUserId: managed.actorUserId,
    orgId: managed.orgId,
    workspaceId: null,
    capability: "billing.subscription.reactivate",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: null,
  });
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

  try {
    // Validate ONLY the env key this action needs (the app origin). A previous
    // version called loadEnv() — which validates the WHOLE monorepo schema — here
    // and OUTSIDE this try/catch, so an unrelated malformed prod var (e.g. an
    // empty STRIPE_WEBHOOK_SECRET) threw an uncaught server-action rejection that
    // wiped the entire billing page with "Something went wrong". Scoping to the
    // one key + keeping it inside the try means any env fault degrades to an
    // actionable toast, never a page crash. (OXA: digest 812344190)
    const env = requireEnv(["NEXT_PUBLIC_APP_URL"] as const);
    const result = await runInTenantScope(
      { orgId: managed.orgId, workspaceId: ORG_ONLY_WS },
      () =>
        changeOrgPlan(managed.orgId, targetPlanSlug, interval, {
          successUrl: `${env.NEXT_PUBLIC_APP_URL}/${orgSlug}/billing/subscription?status=success`,
          cancelUrl: `${env.NEXT_PUBLIC_APP_URL}/${orgSlug}/billing/subscription?status=canceled`,
        }),
    );

    if (result === null) {
      // In-place swap — revalidate and let the client know no redirect is needed.
      revalidatePath(`/${orgSlug}/billing`);
      revalidatePath(`/${orgSlug}/billing/subscription`);
      logger.info(
        { orgSlug, targetPlanSlug, interval },
        "billing: plan swapped in-place",
      );
      emitSecurityEvent({
        eventType: "billing.plan_changed",
        actorUserId: managed.actorUserId,
        orgId: managed.orgId,
        workspaceId: null,
        capability: "billing.plan.change",
        outcome: "success",
        ip: null,
        userAgent: null,
        requestId: null,
      });
      return { ok: true, url: null };
    }

    // New checkout session — redirect. Audit event emitted here too since the
    // action was authorised and initiated (checkout URL creation = plan change
    // intent; the Stripe webhook completes the ledger side).
    logger.info(
      { orgSlug, targetPlanSlug, interval },
      "billing: plan change → Stripe checkout",
    );
    emitSecurityEvent({
      eventType: "billing.plan_changed",
      actorUserId: managed.actorUserId,
      orgId: managed.orgId,
      workspaceId: null,
      capability: "billing.plan.change",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: null,
    });
    return { ok: true, url: result.checkoutUrl };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Plan change failed";
    logger.error(
      { err, orgSlug, targetPlanSlug },
      "billing: changePlanAction failed",
    );
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
  | {
      ok: false;
      code: "seat_limit_reached";
      licenses: number;
      used: number;
      error: string;
    }
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
    await runInTenantScope(
      { orgId: managed.orgId, workspaceId: ORG_ONLY_WS },
      () => setSubscriptionSeats(managed.orgId, seats),
    );
    revalidatePath(`/${orgSlug}/billing`);
    revalidatePath(`/${orgSlug}/billing/subscription`);
    logger.info({ orgSlug, seats }, "billing: seats updated");
    emitSecurityEvent({
      eventType: "billing.seats_changed",
      actorUserId: managed.actorUserId,
      orgId: managed.orgId,
      workspaceId: null,
      capability: "billing.seats.change",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: null,
    });
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
    const message =
      err instanceof Error ? err.message : "Failed to update seats";
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

  try {
    // Scope env validation to the one key used (app origin) and keep it INSIDE
    // the try — a full loadEnv() outside the try would let an unrelated bad
    // prod var (empty STRIPE_WEBHOOK_SECRET) crash the whole page.
    const env = requireEnv(["NEXT_PUBLIC_APP_URL"] as const);
    // Call the billing function directly (mirrors changePlanAction → changeOrgPlan)
    // instead of a server-side fetch() to /api/v1/stripe/credits, which would not
    // forward the session cookie and would make that route's getSession() see an
    // anonymous request. resolveManagedOrg above already authenticates the caller
    // and enforces the owner/admin/billing role.
    const result = await runInTenantScope(
      { orgId: managed.orgId, workspaceId: ORG_ONLY_WS },
      () =>
        createUsageCreditCheckout({
          orgId: managed.orgId,
          grantCents: Math.round(amountUsd * 100),
          successUrl: `${env.NEXT_PUBLIC_APP_URL}/${orgSlug}/billing/subscription?status=success`,
          cancelUrl: `${env.NEXT_PUBLIC_APP_URL}/${orgSlug}/billing/subscription?status=canceled`,
        }),
    );
    // Checkout URL created — credits purchase intent authorised and initiated.
    emitSecurityEvent({
      eventType: "billing.credits_purchased",
      actorUserId: managed.actorUserId,
      orgId: managed.orgId,
      workspaceId: null,
      capability: "purchase_credits",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: null,
    });
    return { ok: true, url: result.url };
  } catch (err) {
    // Free orgs cannot buy usage credits — they must subscribe to a paid plan
    // first. Surface that as actionable copy rather than a raw error string.
    if (isTierDenied(err)) {
      return {
        ok: false,
        error:
          "Usage credits require a paid plan. Upgrade to Build or higher, then add credits.",
      };
    }
    const message =
      err instanceof Error ? err.message : "Credits checkout failed";
    logger.error(
      { err, orgSlug, amountUsd },
      "billing: buyCreditsAction failed",
    );
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
    const preview = await runInTenantScope(
      { orgId: managed.orgId, workspaceId: ORG_ONLY_WS },
      () => previewSeatChange(managed.orgId, seats),
    );
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
    const preview = await runInTenantScope(
      { orgId: managed.orgId, workspaceId: ORG_ONLY_WS },
      () => previewPlanChange(managed.orgId, targetPlanSlug, interval),
    );
    logger.info(
      { orgSlug, targetPlanSlug, interval },
      "billing: previewPlanAction",
    );
    return preview;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Preview failed";
    logger.error(
      { err, orgSlug, targetPlanSlug },
      "billing: previewPlanAction failed",
    );
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
    const { clientSecret } = await runInTenantScope(
      { orgId: managed.orgId, workspaceId: ORG_ONLY_WS },
      () => createPaymentMethodSetupIntent(managed.orgId),
    );
    logger.info({ orgSlug }, "billing: createSetupIntentAction");
    emitSecurityEvent({
      eventType: "billing.payment_method_added",
      actorUserId: managed.actorUserId,
      orgId: managed.orgId,
      workspaceId: null,
      capability: "billing.payment_method.add",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: null,
    });
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
    await runInTenantScope(
      { orgId: managed.orgId, workspaceId: ORG_ONLY_WS },
      () => syncPaymentMethodsFromStripe(managed.orgId),
    );
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
    await runInTenantScope(
      { orgId: managed.orgId, workspaceId: ORG_ONLY_WS },
      () => setOrgDefaultPaymentMethod(managed.orgId, paymentMethodId),
    );
    revalidatePath(`/${orgSlug}/billing/subscription`);
    logger.info(
      { orgSlug, paymentMethodId },
      "billing: setDefaultPaymentMethodAction",
    );
    emitSecurityEvent({
      eventType: "billing.payment_method_default_changed",
      actorUserId: managed.actorUserId,
      orgId: managed.orgId,
      workspaceId: null,
      capability: "billing.payment_method.set_default",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: null,
    });
    return { ok: true };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to set default";
    logger.error(
      { err, orgSlug, paymentMethodId },
      "billing: setDefaultPaymentMethodAction failed",
    );
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
    await runInTenantScope(
      { orgId: managed.orgId, workspaceId: ORG_ONLY_WS },
      () => removeOrgPaymentMethod(managed.orgId, paymentMethodId),
    );
    revalidatePath(`/${orgSlug}/billing/subscription`);
    logger.info(
      { orgSlug, paymentMethodId },
      "billing: removePaymentMethodAction",
    );
    emitSecurityEvent({
      eventType: "billing.payment_method_removed",
      actorUserId: managed.actorUserId,
      orgId: managed.orgId,
      workspaceId: null,
      capability: "billing.payment_method.remove",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: null,
    });
    return { ok: true };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to remove payment method";
    logger.error(
      { err, orgSlug, paymentMethodId },
      "billing: removePaymentMethodAction failed",
    );
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
    const settings = await runInTenantScope(
      { orgId: managed.orgId, workspaceId: ORG_ONLY_WS },
      () => updateAutoReloadSettings(managed.orgId, updates),
    );
    revalidatePath(`/${orgSlug}/billing/subscription`);
    logger.info({ orgSlug }, "billing: updateAutoReloadAction");
    emitSecurityEvent({
      eventType: "billing.auto_reload_updated",
      actorUserId: managed.actorUserId,
      orgId: managed.orgId,
      workspaceId: null,
      capability: "billing.auto_reload.update",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: null,
    });
    return { ok: true, settings };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update auto-reload";
    logger.error({ err, orgSlug }, "billing: updateAutoReloadAction failed");
    return { error: message };
  }
}
