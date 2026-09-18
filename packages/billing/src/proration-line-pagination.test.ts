/**
 * Every line of a previewed invoice, not the first handful of them.
 *
 * `Invoice.lines` is an `ApiList`, and the SDK says so in the method the API
 * provides for exactly this: "When retrieving an upcoming invoice, you'll get a
 * lines property containing the total count of line items and THE FIRST HANDFUL
 * of those items. There is also a URL where you can retrieve the full
 * (paginated) list." The embedded page carries `has_more` to say when it is not
 * the whole story, and this adapter read `preview.lines.data` and never looked
 * at it.
 *
 * A plan change writes two prorations — a credit for unused time on the old
 * price and a charge for remaining time on the new one. If enough pending
 * invoice items push the charge onto page two, the direction is computed from
 * the credit alone: a real upgrade reads nonpositive, `planChangeDirection`
 * selects `none`, and the immediate charge is never raised. That is the same
 * money-loss as the anchor collision, and it needs no concurrency at all — only
 * a customer with enough pending items (#3157, PR #3171 review).
 *
 * The baseline anchor check had the identical hole: an interloping proration
 * beyond the first page left `pendingAtAnchor` at zero, so the ownership check
 * passed by not looking.
 *
 * The walk is BOUNDED, and the bound is refused rather than truncated —
 * `autoPagingToArray` requires a limit, so a bound is forced by the API and the
 * only choice is what happens past it. Answering from a set we know is
 * incomplete is the one thing this PR never does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const stripeMethods = {
  customers: { retrieve: vi.fn(), update: vi.fn() },
  subscriptions: { retrieve: vi.fn(), update: vi.fn(), cancel: vi.fn() },
  invoices: {
    createPreview: vi.fn(),
    retrieve: vi.fn(),
    listUpcomingLines: vi.fn(),
  },
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
 * The subscription a preview reports having been computed against.
 *
 * The adapter derives the billing interval from the preview's own response
 * rather than from the retrieval beside it (r4042380655), so every stubbed
 * change-preview has to say what it priced. These tests are about LINE
 * PAGING, not intervals, so it simply agrees with `subscriptions.retrieve`.
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

const UNUSED_CENTS = -40_000;
const REMAINING_CENTS = 52_000;
/** What the change actually moves: +$120. Only visible across both pages. */
const NET_CENTS = UNUSED_CENTS + REMAINING_CENTS;

function prorationLine(
  description: string,
  amount: number,
  anchor: number,
): Record<string, unknown> {
  return {
    proration: true,
    description,
    amount,
    period: { start: anchor, end: anchor + 100 },
  };
}

/** A filler pending item, of the kind that pushes real lines onto page two. */
function fillerLine(i: number): Record<string, unknown> {
  return {
    proration: false,
    description: `Pending item ${i}`,
    amount: 100,
    period: { start: 1_600_000_000, end: 1_600_000_100 },
  };
}

/**
 * `splitAcrossPages` puts the credit on page one and the charge on page two —
 * the shape that makes an upgrade read as a downgrade.
 *
 * `baselineInterloperOnPageTwo` hides a proration at OUR anchor beyond the
 * first page of the BASELINE, which is the same hole in the ownership check.
 */
function stubPreviews(opts: {
  splitAcrossPages?: boolean;
  baselineInterloperOnPageTwo?: boolean;
}): void {
  const anchorOf = (args: {
    subscription_details?: { proration_date?: number };
  }) => args.subscription_details?.proration_date;

  stripeMethods.invoices.createPreview.mockImplementation(async (args) => {
    const anchor = anchorOf(args);
    const nowSecond = Math.floor(Date.now() / 1000);
    if (anchor === undefined) {
      // Baseline. Its first page is clean either way; the interloper, when
      // there is one, sits beyond it.
      return {
        currency: "usd",
        total: 0,
        amount_due: 0,
        lines: {
          data: [fillerLine(1)],
          has_more: Boolean(opts.baselineInterloperOnPageTwo),
        },
      };
    }
    return {
      subscription: PREVIEWED_SUBSCRIPTION,
      currency: "usd",
      total: NET_CENTS,
      amount_due: NET_CENTS,
      lines: opts.splitAcrossPages
        ? {
            data: [prorationLine("Unused time on Build", UNUSED_CENTS, anchor)],
            has_more: true,
          }
        : {
            data: [
              prorationLine("Unused time on Build", UNUSED_CENTS, anchor),
              prorationLine("Remaining time on Scale", REMAINING_CENTS, anchor),
            ],
            has_more: false,
          },
    };
  });

  stripeMethods.invoices.listUpcomingLines.mockImplementation((args) => {
    const anchor = anchorOf(args ?? {});
    const nowSecond = Math.floor(Date.now() / 1000);
    const all =
      anchor === undefined
        ? [
            fillerLine(1),
            ...(opts.baselineInterloperOnPageTwo
              ? [
                  prorationLine(
                    "Unused seats (a decrease made this same second)",
                    -90_000,
                    nowSecond,
                  ),
                ]
              : []),
          ]
        : [
            prorationLine("Unused time on Build", UNUSED_CENTS, anchor),
            prorationLine("Remaining time on Scale", REMAINING_CENTS, anchor),
          ];
    return { autoPagingToArray: async () => all };
  });
}

describe("a previewed invoice whose lines do not fit on one page (#3157, PR #3171 review)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubSubscription();
  });

  it("reads the charge that page one left behind", async () => {
    stubPreviews({ splitAcrossPages: true });

    const preview = await provider.previewPlanChange("sub_001", {
      newPriceId: "price_scale_m",
    });

    // From page one alone this is -$400 and reads as a downgrade, which ships
    // `none` and drops the upgrade charge entirely.
    expect(preview.amountCents).toBe(NET_CENTS);
    expect(preview.isCharge).toBe(true);
    expect(preview.lines).toHaveLength(2);
  });

  it("reads every line for a seat change too", async () => {
    // The sibling. Same function, same omission.
    stubPreviews({ splitAcrossPages: true });

    const preview = await provider.previewSeatChange("sub_001", { seats: 5 });

    expect(preview.amountCents).toBe(NET_CENTS);
  });

  it("finds an interloping anchor hiding beyond the baseline's first page", async () => {
    // The ownership check passed by not looking. Paging only the change
    // preview and not the baseline leaves this open.
    stubPreviews({ baselineInterloperOnPageTwo: true });

    await expect(
      provider.previewPlanChange("sub_001", { newPriceId: "price_scale_m" }),
    ).rejects.toMatchObject({ code: "PRORATION_ANCHOR_AMBIGUOUS" });
  });

  it("refuses rather than price from a set it knows is truncated", async () => {
    // The bound is forced by the SDK: autoPagingToArray takes a required
    // limit. What is not forced is what happens when the walk reaches it, and
    // a sum over a known-incomplete set is exactly how an upgrade reads as a
    // downgrade.
    stubPreviews({ splitAcrossPages: true });
    stripeMethods.invoices.listUpcomingLines.mockImplementation(() => ({
      autoPagingToArray: async (opts: { limit: number }) =>
        Array.from({ length: opts.limit }, (_, i) => fillerLine(i)),
    }));

    await expect(
      provider.previewPlanChange("sub_001", { newPriceId: "price_scale_m" }),
    ).rejects.toMatchObject({ code: "PRORATION_LINES_TRUNCATED" });
  });

  it("does not page when everything already fits", async () => {
    // The discriminating negative: the ordinary quote must not grow a round
    // trip, so `has_more: false` means the embedded page is the whole story.
    stubPreviews({});

    const preview = await provider.previewPlanChange("sub_001", {
      newPriceId: "price_scale_m",
    });

    expect(preview.amountCents).toBe(NET_CENTS);
    expect(stripeMethods.invoices.listUpcomingLines).not.toHaveBeenCalled();
  });
});
