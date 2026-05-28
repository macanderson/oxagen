import type { CapabilityHandler } from "@oxagen/oxagen";
import { billingSubscriptionRead } from "@oxagen/oxagen/contracts/billing.subscription.read";
import { db, schema } from "@oxagen/database";
import { and, eq, inArray } from "drizzle-orm";

const ACTIVE_STATUSES = ["trialing", "active", "past_due", "paused"];

export const billingSubscriptionReadHandler: CapabilityHandler<typeof billingSubscriptionRead> =
  async (_input, ctx) => {
    const d = db();

    // Single round trip per panel render: subscription + plan + credit
    // balance. No N+1 — three indexed lookups, all bounded result sets.
    const sub = await d.query.subscriptions.findFirst({
      where: and(
        eq(schema.subscriptions.tenantId, ctx.tenantId),
        inArray(schema.subscriptions.status, ACTIVE_STATUSES),
      ),
      columns: {
        publicId: true,
        status: true,
        billingInterval: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        seatCount: true,
        planId: true,
      },
    });

    const planSlug = sub
      ? (
          await d.query.plans.findFirst({
            where: eq(schema.plans.id, sub.planId),
            columns: { slug: true },
          })
        )?.slug ?? "unknown"
      : null;

    const balance = await d.query.creditBalances.findFirst({
      where: eq(schema.creditBalances.tenantId, ctx.tenantId),
      columns: { balanceCents: true },
    });

    return {
      subscription:
        sub && planSlug
          ? {
              publicId: sub.publicId,
              status: sub.status,
              planSlug,
              billingInterval: (sub.billingInterval === "year" ? "year" : "month") as
                | "month"
                | "year",
              currentPeriodStart: sub.currentPeriodStart.toISOString(),
              currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
              cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
              seatCount: sub.seatCount,
            }
          : null,
      creditBalanceCents: Number(balance?.balanceCents ?? 0n),
    };
  };
