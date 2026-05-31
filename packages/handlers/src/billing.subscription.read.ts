import type { CapabilityHandler } from "@oxagen/oxagen";
import { billingSubscriptionRead } from "@oxagen/oxagen/contracts/billing.subscription.read";
import { db, schema } from "@oxagen/database";
import { sumTokenUsage } from "@oxagen/telemetry";
import { and, eq, inArray } from "drizzle-orm";
import { logger } from "./logger.js";

const ACTIVE_STATUSES = ["trialing", "active", "past_due", "paused"];

export const billingSubscriptionReadHandler: CapabilityHandler<typeof billingSubscriptionRead> =
  async (_input, ctx) => {
    // Authorization guard: a resolved principal (user or API key) is required.
    // API-key calls always carry a non-empty orgId; session calls that lack
    // org scope are rejected here rather than at the transport layer so the
    // check is surface-agnostic (API, MCP, agent — same code path).
    if (!ctx.userId && !ctx.apiKeyId) {
      throw new Error("Unauthorized: no authenticated principal");
    }
    if (!ctx.orgId) {
      throw new Error("Forbidden: orgId is required to read billing data");
    }

    const d = db();

    // Single round trip per panel render: subscription + plan + credit
    // balance. No N+1 — three indexed lookups, all bounded result sets.
    const sub = await d.query.subscriptions.findFirst({
      where: and(
        eq(schema.subscriptions.orgId, ctx.orgId),
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
      where: eq(schema.creditBalances.orgId, ctx.orgId),
      columns: { balanceCents: true },
    });

    // OXA-1347: roll up the current billing period's token + cost totals
    // from ClickHouse when a subscription is active. Telemetry is best-
    // effort: if CH is down the panel still renders subscription + balance.
    let periodUsage: {
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      costMicros: number;
      executions: number;
    } | null = null;
    if (sub) {
      try {
        const rollup = await sumTokenUsage({
          orgId: ctx.orgId,
          periodStart: sub.currentPeriodStart,
          periodEnd: sub.currentPeriodEnd,
        });
        const get = (m: string) => rollup.find((r) => r.metric === m);
        periodUsage = {
          inputTokens: get("tokens_input")?.quantity ?? 0,
          outputTokens: get("tokens_output")?.quantity ?? 0,
          cachedTokens: get("tokens_cached")?.quantity ?? 0,
          costMicros: Number(get("executions")?.costMicros ?? 0n),
          executions: get("executions")?.quantity ?? 0,
        };
      } catch (err) {
        // CH failure must not break the billing panel, but must not be silent.
        logger.warn(
          { err, orgId: ctx.orgId },
          "billing.subscription.read: ClickHouse sumTokenUsage failed — periodUsage will be null",
        );
      }
    }

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
      periodUsage,
    };
  };
