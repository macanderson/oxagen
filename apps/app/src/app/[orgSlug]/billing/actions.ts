"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import {
  cancelOrgSubscription,
  reactivateOrgSubscription,
  changeOrgPlan,
  setSubscriptionSeats,
  isSeatLimitError,
} from "@oxagen/billing";
import { loadEnv } from "@oxagen/config/env";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";
import { logger } from "@oxagen/handlers/logger";

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
