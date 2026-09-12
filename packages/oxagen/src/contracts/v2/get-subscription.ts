import { z } from "zod";
import { defineTool } from "./_define";
import { billingSubscriptionRead } from "../billing.subscription.read";

/**
 * Appendix E: `get_subscription` — absorbs `get_subscription`. The Does column
 * is empty, which is Appendix E saying the job did not change: read the plan
 * and the period for the active tenant. §14's org Billing page is what it
 * serves — "Governed-action usage, the retention meter, plan, and invoices."
 *
 * A 1:1 carry in name only. §12.1 rewrites what a subscription IS: per-run
 * pricing with the first thousand runs free, retention metered in GB-months
 * past thirteen months, platform-funded tokens billed at cost, and explicitly
 * "no credits, no resellers, and no revenue dashboard". A.10 confirms it from
 * the other side — `billing.credit_*`, `billing.invoices` and
 * `billing.payment_methods` are gone, because Stripe holds invoices and cards
 * and Oxagen holds the meter. So the meters A.8 `billing.subscriptions`
 * actually stores are added, and the two fields that priced the old model are
 * dropped.
 */

// Carried whole so every field keeps its shape and its nullability; the two
// omissions below are the drops, written where a reader can see them.
const subscription = billingSubscriptionRead.output.shape.subscription.unwrap();
const periodUsage = billingSubscriptionRead.output.shape.periodUsage.unwrap();

export const getSubscription = defineTool({
  name: "get_subscription",
  domain: "billing",
  description:
    "Read the organization's subscription: plan, status, billing interval, current period bounds, and whether it cancels at period end, together with the meters that price it — runs this period against the included allowance, retained gigabytes against the included months, governed actions, assistant usage, and the period's token and cost totals (§12.1, A.8).",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  scoped: true,

  absorbs: ["get_subscription"],
  drops: [
    {
      field: "creditBalanceCents",
      from: "get_subscription",
      why: "§12.1: 'There are no credits, no resellers, and no revenue dashboard.' A.10 removes billing.credit_* outright — the meter that replaces it is runsThisPeriod against includedRuns",
    },
    {
      field: "seatCount",
      from: "get_subscription",
      why: "§12.1 prices per run, not per seat, and A.8 billing.subscriptions has no seat column. Enterprise is committed use, also not seats",
    },
    {
      field: "periodUsage.executions",
      from: "get_subscription",
      why: "§3 bans the word — 'execution and invocation (say run or step)'. The count that matters for billing is runsThisPeriod (§12.1's billable unit: a sealed run with at least one model call), and modelCalls carries the raw call count where it is still wanted",
    },
  ],

  // Clean carry: single source, and nothing in §12.1 or §14 argues for a
  // different classification. Reading the plan is a low-sensitivity org read.
  agent: { requiresApproval: false, riskLevel: "low", category: "billing" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    // Carried unchanged. The empty workspace map is correct rather than an
    // omission: §14 puts Billing among the three organization-scope pages.
    org: { Owner: "allow", Admin: "allow", Billing: "allow" },
    workspace: {},
  },
  /**
   * New here, and deliberate: §12.1 gives every organization the free tier with
   * "every governance feature on", so a tenant that has run out of allowance
   * must still be able to read the plan that says so.
   */
  noBillingGate: true,
  // Carried. The handler reads the subscription row and the period rollup; no
  // write path exists in it.
  mutates: false,

  input: z.object({}),

  output: z.object({
    /** Null for an organization still on the free tier — carried nullability. */
    subscription: subscription.omit({ seatCount: true }).nullable(),

    /**
     * A.8 `billing.subscriptions`, new. These are the numbers §14's Billing
     * page names and §12.1 prices: the run meter against its included
     * allowance, the retention meter against its included months, and the
     * governed-action count §3 keeps as a reported secondary meter.
     */
    meters: z.object({
      runsThisPeriod: z.number().int().nonnegative(),
      includedRuns: z.number().int().nonnegative(),
      /** Per-run price above the included allowance, in micro-USD (§12.3). */
      overagePriceMicros: z.number().int().nonnegative(),
      retainedGb: z.number().nonnegative(),
      retentionIncludedMonths: z.number().int().nonnegative(),
      retentionPriceMicrosPerGbMonth: z.number().int().nonnegative(),
      /**
       * §3: "Invoices and the UI show it as action." Reported, not priced —
       * §12.1 keeps the governed-action count as a secondary meter so it can be
       * priced later without changing the model.
       */
      governedActions: z.number().int().nonnegative(),
      /**
       * §4.5: tokens Oxagen bought on the org's behalf under the `platform`
       * funding source, billed back at cost plus a published markup. Zero for an
       * org on `customer_key`, whose tokens are reported and billed at zero.
       */
      assistantMicrosThisPeriod: z.number().int().nonnegative(),
    }),

    /**
     * Carried: the current-period token and cost snapshot, so the Billing panel
     * renders totals without a second round trip. Null before the first metered
     * call of the period.
     */
    periodUsage: periodUsage
      .omit({ executions: true })
      .extend({
        /** Metered model calls in the period — `executions` under §3's vocabulary. */
        modelCalls: z.number().int().nonnegative(),
      })
      .nullable(),
  }),
});

export type GetSubscriptionInput = z.output<typeof getSubscription.input>;
export type GetSubscriptionOutput = z.output<typeof getSubscription.output>;
