/**
 * Two prorations that share an anchor, and why the anchor alone cannot say
 * which of them this change created.
 *
 * `proration_date` is Unix SECONDS, and both preview paths generate it with
 * `Math.floor(Date.now() / 1000)`. Stripe stamps each proration it creates with
 * the `proration_date` it was given, so a seat decrease committed under
 * `create_prorations` in the same second as a plan-change preview produces a
 * pending credit whose `period.start` is identical to this preview's anchor. It
 * passes the ownership filter, its credit is summed into `amountCents`, a real
 * upgrade reads nonpositive, `changeOrgPlan` ships `proration_behavior: "none"`
 * and the immediate charge is never raised.
 *
 * That is the same money-loss `r4037169821` closed, reopened by the fix for it:
 * the anchor filter equated timestamp equality with ownership, and at
 * one-second granularity equality is not ownership. The collision is
 * STRUCTURAL rather than unlucky — nothing anywhere narrows the value below a
 * second (#3157, PR #3171 review).
 *
 * WHAT THE FIX IS AND WHY IT IS NOT A CLEVERER FILTER.
 *
 * The payload does not carry a field that says "this line came from the change
 * you just simulated". `type` is documented only as the line's SOURCE
 * (`invoiceitem` or `subscription`), `subscription_item` is the same item for
 * both the pending proration and ours, and `proration_details.credited_items`
 * exists only on credit lines. Guessing at any of them would be one more
 * stand-in for a fact nobody recorded, which is the argument this whole change
 * is built on.
 *
 * So the anchor is checked against what is OBSERVED rather than inferred: a
 * baseline preview of the invoice as it stands, WITHOUT the change, says
 * whether a proration already sits at that second. If one does, this change's
 * money cannot be isolated and the adapter refuses instead of guessing. A
 * refusal on a same-second collision is recoverable — the next attempt gets a
 * fresh anchor — and summing a stranger's credit into an upgrade is not.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const stripeMethods = {
  customers: { retrieve: vi.fn(), update: vi.fn() },
  subscriptions: { retrieve: vi.fn(), update: vi.fn(), cancel: vi.fn() },
  invoices: { createPreview: vi.fn(), retrieve: vi.fn() },
  paymentMethods: { list: vi.fn(), detach: vi.fn() },
};

vi.mock("stripe", () => ({ default: vi.fn(() => stripeMethods) }));

vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({
    STRIPE_SECRET_KEY: "sk_test_mock",
    STRIPE_WEBHOOK_SECRET: "whsec_mock",
    NEXT_PUBLIC_APP_URL: "https://app.test",
  }),
}));

const { StripeProvider } = await import("./stripe-provider");

const provider = new StripeProvider();

function stubSubscription(): void {
  stripeMethods.subscriptions.retrieve.mockResolvedValue({
    id: "sub_001",
    customer: "cus_001",
    metadata: {},
    status: "active",
    items: {
      data: [
        {
          id: "si_001",
          quantity: 3,
          price: {
            id: "price_build_m",
            recurring: { interval: "month" },
            product: "prod_build",
          },
        },
      ],
    },
    current_period_start: 1_756_684_800,
    current_period_end: 1_759_276_800,
    cancel_at_period_end: false,
    canceled_at: null,
    trial_end: null,
  });
}

/**
 * Drives the two createPreview calls apart.
 *
 * The baseline call carries no `subscription_details` — it is the invoice as it
 * stands. The change call carries the items and the anchor. `pendingAtNow`
 * decides whether a proration from somebody else's change is already sitting on
 * the invoice at this very second.
 */
/**
 * The subscription a preview reports having been computed against.
 *
 * The adapter derives the billing interval from the preview's own response
 * rather than from the retrieval beside it (r4042380655), so every stubbed
 * change-preview has to say what it priced. These tests are about proration
 * ANCHORS, not intervals, so it simply agrees with `subscriptions.retrieve`.
 * The case where the two disagree is `plan-change-provider-interval.test.ts`.
 */
const PREVIEWED_SUBSCRIPTION = {
  id: "sub_001",
  customer: "cus_001",
  metadata: {},
  status: "active",
  items: {
    data: [
      {
        id: "si_001",
        quantity: 3,
        price: {
          id: "price_build_m",
          recurring: { interval: "month" },
          product: "prod_build",
        },
      },
    ],
  },
  current_period_start: 1_756_684_800,
  current_period_end: 1_759_276_800,
  cancel_at_period_end: false,
  canceled_at: null,
  trial_end: null,
};

function stubPreviews(opts: {
  pendingAtNow: boolean;
  pendingAtOtherAnchor?: boolean;
}): void {
  stripeMethods.invoices.createPreview.mockImplementation(
    async (args: { subscription_details?: { proration_date?: number } }) => {
      const anchor = args.subscription_details?.proration_date;
      const nowSecond = Math.floor(Date.now() / 1000);
      const pending: Array<Record<string, unknown>> = [];
      if (opts.pendingAtNow) {
        pending.push({
          proration: true,
          description: "Unused seats (a decrease made this same second)",
          amount: -90_000,
          period: { start: nowSecond, end: nowSecond + 100 },
        });
      }
      if (opts.pendingAtOtherAnchor) {
        pending.push({
          proration: true,
          description: "Unused seats (a decrease made last week)",
          amount: -20_000,
          period: { start: 1_600_000_000, end: nowSecond },
        });
      }
      // The baseline: no change simulated, so only what is already pending.
      if (anchor === undefined) {
        return {
          currency: "usd",
          total: 0,
          amount_due: 0,
          lines: { data: pending },
        };
      }
      // The change preview: the pending lines plus the two this change makes.
      return {
        subscription: PREVIEWED_SUBSCRIPTION,
        currency: "usd",
        total: 12_000,
        amount_due: 12_000,
        lines: {
          data: [
            ...pending,
            {
              proration: true,
              description: "Unused time on Build",
              amount: -40_000,
              period: { start: anchor, end: anchor + 100 },
            },
            {
              proration: true,
              description: "Remaining time on Scale",
              amount: 52_000,
              period: { start: anchor, end: anchor + 100 },
            },
          ],
        },
      };
    },
  );
}

/** What this change alone moves: +$120, an unambiguous upgrade. */
const THIS_CHANGE_NET_CENTS = 12_000;

/**
 * Drives the baseline reads apart by ORDER, so a commit can be interleaved
 * between them.
 *
 * With the bracket the sequence is baseline -> changed preview -> baseline. The
 * interloper is injected from `appearsFromCall` onward, which is how a change
 * committed part-way through the pair is modelled; `vanishesFromCall` models
 * the opposite, a pending proration swept onto a finalised invoice.
 */
function stubInterleaved(opts: {
  appearsFromCall: number;
  vanishesFromCall?: number;
}): void {
  let call = 0;
  stripeMethods.invoices.createPreview.mockImplementation(
    async (args: { subscription_details?: { proration_date?: number } }) => {
      call += 1;
      const anchor = args.subscription_details?.proration_date;
      const nowSecond = Math.floor(Date.now() / 1000);
      const visible =
        call >= opts.appearsFromCall &&
        (opts.vanishesFromCall === undefined || call < opts.vanishesFromCall);
      const pending = visible
        ? [
            {
              proration: true,
              description: "Unused seats (a decrease landing mid-quote)",
              amount: -90_000,
              period: { start: nowSecond, end: nowSecond + 100 },
            },
          ]
        : [];
      if (anchor === undefined) {
        return {
          currency: "usd",
          total: 0,
          amount_due: 0,
          lines: { data: pending, has_more: false },
        };
      }
      return {
        subscription: PREVIEWED_SUBSCRIPTION,
        currency: "usd",
        total: 12_000,
        amount_due: 12_000,
        lines: {
          has_more: false,
          data: [
            ...pending,
            {
              proration: true,
              description: "Unused time on Build",
              amount: -40_000,
              period: { start: anchor, end: anchor + 100 },
            },
            {
              proration: true,
              description: "Remaining time on Scale",
              amount: 52_000,
              period: { start: anchor, end: anchor + 100 },
            },
          ],
        },
      };
    },
  );
}

describe("a change that lands between the baseline and the preview (#3157, PR #3171 review)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubSubscription();
  });

  it("refuses when a proration appears at the anchor after the baseline was read", async () => {
    // The TOCTOU pair: the baseline came back clean, the commit landed, and the
    // changed preview carries a credit the baseline never saw. One read cannot
    // detect this; a second one after the preview can.
    stubInterleaved({ appearsFromCall: 2 });

    await expect(
      provider.previewPlanChange("sub_001", { newPriceId: "price_scale_m" }),
    ).rejects.toMatchObject({ code: "PRORATION_ANCHOR_AMBIGUOUS" });
  });

  it("refuses the interleaved case on the seat path too", async () => {
    stubInterleaved({ appearsFromCall: 2 });

    await expect(
      provider.previewSeatChange("sub_001", { seats: 5 }),
    ).rejects.toMatchObject({ code: "PRORATION_ANCHOR_AMBIGUOUS" });
  });

  it("refuses when the interloper is gone again by the closing baseline", async () => {
    // The mirror case, and the reason the opening read is kept rather than
    // replaced by the closing one: the proration was at our anchor, it was in
    // the preview we priced, and it had been swept onto a finalised invoice
    // before the closing read. Only the opening read ever saw it.
    stubInterleaved({ appearsFromCall: 1, vanishesFromCall: 3 });

    await expect(
      provider.previewPlanChange("sub_001", { newPriceId: "price_scale_m" }),
    ).rejects.toMatchObject({ code: "PRORATION_ANCHOR_AMBIGUOUS" });
  });

  it("still quotes when nothing lands during the window", async () => {
    // The discriminating negative: bracketing must not refuse every quote.
    stubInterleaved({ appearsFromCall: 99 });

    const preview = await provider.previewPlanChange("sub_001", {
      newPriceId: "price_scale_m",
    });

    expect(preview.amountCents).toBe(THIS_CHANGE_NET_CENTS);
    expect(preview.isCharge).toBe(true);
  });
});

describe("a proration anchor another change already occupies (#3157, PR #3171 review)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubSubscription();
  });

  it("refuses to price a plan change whose anchor is already taken", async () => {
    stubPreviews({ pendingAtNow: true });

    // Summing it instead makes a +$120 upgrade read as -$780, which selects
    // `none` and drops the charge entirely.
    await expect(
      provider.previewPlanChange("sub_001", { newPriceId: "price_scale_m" }),
    ).rejects.toMatchObject({ code: "PRORATION_ANCHOR_AMBIGUOUS" });
  });

  it("refuses to price a seat change whose anchor is already taken", async () => {
    // The sibling. `previewSeatChange` generates its anchor the same way and
    // summarises through the same function, so the ambiguity is identical.
    stubPreviews({ pendingAtNow: true });

    await expect(
      provider.previewSeatChange("sub_001", { seats: 5 }),
    ).rejects.toMatchObject({ code: "PRORATION_ANCHOR_AMBIGUOUS" });
  });

  it("prices a change whose anchor is its own", async () => {
    // The discriminating negative. A fix that refuses whenever any proration
    // is present, or refuses unconditionally, fails here.
    stubPreviews({ pendingAtNow: false });

    const preview = await provider.previewPlanChange("sub_001", {
      newPriceId: "price_scale_m",
    });

    expect(preview.amountCents).toBe(THIS_CHANGE_NET_CENTS);
    expect(preview.isCharge).toBe(true);
  });

  it("still ignores a pending proration anchored at some other second", async () => {
    // The r4037169821 case, which this must not regress: an older pending
    // credit is not ours, is not at our anchor, and is neither summed nor
    // treated as an ambiguity.
    stubPreviews({ pendingAtNow: false, pendingAtOtherAnchor: true });

    const preview = await provider.previewPlanChange("sub_001", {
      newPriceId: "price_scale_m",
    });

    expect(preview.amountCents).toBe(THIS_CHANGE_NET_CENTS);
    expect(preview.lines).toHaveLength(2);
  });

  it("prices a seat change whose anchor is its own", async () => {
    stubPreviews({ pendingAtNow: false });

    const preview = await provider.previewSeatChange("sub_001", { seats: 5 });

    expect(preview.amountCents).toBe(THIS_CHANGE_NET_CENTS);
  });
});
