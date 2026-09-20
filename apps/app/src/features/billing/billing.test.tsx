// @vitest-environment jsdom
// The Billing page (pages/billing.md) over a fake DataSource: the reads it
// makes (including the extra newest-invoices read when the URL is on an
// older page), the header and its Change plan action, the four summary
// tiles, This month, Meters, Invoices, and the checkout banner, each in its
// ok, empty, denied and error states, with an axe check in every one
// (INV-26). The section internals below the page — Auto top-up, Buy governed
// action units and Usage credits' own controls — have their own test files;
// this file covers the page-level derivations that feed them (role gates,
// the block size handed down from the rate).
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrgRole } from "@/data/contracts/common";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  type BillingReads,
  billingSource,
  contractRate,
  freeNoCardBucket,
  invoiceBucket,
  invoicePage,
  invoiceRow,
  prepaidBucket,
  PUBLISHED_BUILD,
  usageCredits,
} from "./billing.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
// Each write is tested through its own control (auto-topup.test.tsx,
// purchase-form.test.tsx, usage-credits reads through the section itself,
// change-plan.test.tsx). Every mock lives in one factory because a second
// vi.mock of the same path replaces the first, which would leave a control
// reading an action the mock never defined.
vi.mock("./actions", () => ({
  setAutoTopup: vi.fn(),
  purchaseGau: vi.fn(),
  purchaseCredits: vi.fn(),
  startPlanChange: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Billing, BillingActions } = await import("./billing");

const viewer = (orgRole: OrgRole) =>
  unsafeMint(OrgCtx, {
    userId: "usr_marcusbell",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole,
  });

const DENIED = {
  ok: false,
  reason: "denied",
  permission: "org.billing",
} as const;
const DOWN = readError("stripe_unreachable", 502);

async function renderBilling(
  reads: Partial<BillingReads> & {
    newestInvoices?: BillingReads["invoices"];
  } = {},
  options: {
    role?: OrgRole;
    checkout?: string | null;
    cursor?: string | null;
  } = {},
) {
  const ctx = viewer(options.role ?? "owner");
  const { source, calls } = billingSource(reads);
  // page.tsx renders the header and hands BillingActions to its actions
  // slot; the test composes the two the way the route does, minus the h1.
  const [actions, body] = await Promise.all([
    BillingActions({ ctx, source }),
    Billing({
      ctx,
      source,
      checkout: options.checkout ?? null,
      cursor: options.cursor ?? null,
    }),
  ]);
  render(
    <IntlProvider>
      {actions}
      {body}
    </IntlProvider>,
  );
  return { ctx, calls };
}

const section = (name: string) => screen.getByRole("region", { name });
/** A summary tile by its stable `data-tile` name (Tile, summary.tsx). */
const tile = (name: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-tile="${name}"]`);
  if (found === null) throw new Error(`no ${name} tile`);
  return found;
};

afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("reads", () => {
  it("reads the plan (once for the body, once for Change plan), the bucket, the rate, the credit balance and the newest invoices page, with no second invoices read", async () => {
    const { ctx, calls } = await renderBilling({}, { cursor: null });
    expect(calls).toEqual({
      plan: [[ctx], [ctx]],
      bucket: [[ctx]],
      rate: [[ctx]],
      invoices: [[ctx, { cursor: null }]],
      usageCredits: [[ctx]],
    });
  });

  it("also reads the newest invoices page when the URL asks for an older one", async () => {
    const { ctx, calls } = await renderBilling({}, { cursor: "c2" });
    expect(calls.invoices).toEqual([
      [ctx, { cursor: "c2" }],
      [ctx, { cursor: null }],
    ]);
  });

  it("rolls the tiles and This month up from the newest page, not the page on screen", async () => {
    await renderBilling(
      {
        invoices: invoicePage([
          invoiceRow({ status: "open", amountDue: money("500") }),
        ]),
        newestInvoices: invoicePage([
          invoiceRow({ status: "open", amountDue: money("700") }),
        ]),
      },
      { cursor: "c2" },
    );
    expect(tile("due")).toHaveTextContent("$700.00");
    expect(
      within(section("Invoices")).getByRole("cell", { name: "$500.00" }),
    ).toBeInTheDocument();
  });
});

function money(dollars: string): { micros: string; currency: string } {
  return { micros: `${dollars}000000`, currency: "USD" };
}

describe("section order", () => {
  it("draws the tiles, then This month, Meters and Invoices, then the price list, Auto top-up, Buy governed action units, Usage credits and What counts", async () => {
    await renderBilling();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual([
      "This month",
      "Meters",
      "Invoices",
      "The price list",
      "Auto top-up",
      "Buy governed action units",
      "Usage credits",
      "What counts",
    ]);
  });
});

describe("header", () => {
  it("opens the plan dialog to the subscribed sentence for an owner whose organization already has a plan", async () => {
    await renderBilling();
    await userEvent.click(screen.getByRole("button", { name: "Change plan" }));
    expect(
      screen.getByRole("dialog", { name: "Change plan" }),
    ).toHaveTextContent("This organization already has a build subscription.");
  });

  it("opens the plan dialog to the role-denied sentence for a member (negative)", async () => {
    await renderBilling({}, { role: "member" });
    await userEvent.click(screen.getByRole("button", { name: "Change plan" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "An owner or a billing member can change the plan.",
    );
  });

  it("opens the plan dialog to the plan form for an owner with no subscription", async () => {
    await renderBilling({ plan: readOk({ subscription: null }) });
    await userEvent.click(screen.getByRole("button", { name: "Change plan" }));
    expect(
      within(screen.getByRole("dialog")).getByRole("radio", { name: /Build/ }),
    ).toBeInTheDocument();
  });
});

describe("checkout banner", () => {
  it.each([
    [
      "success",
      "Checkout finished. The governed action units you bought are added to the bucket once Stripe confirms the payment.",
    ],
    ["cancel", "Checkout was cancelled. Nothing was charged."],
    [
      "credits",
      "Checkout finished. The usage credits you bought are added to the balance once Stripe confirms the payment.",
    ],
    [
      "plan",
      "Checkout finished. The new plan applies once Stripe confirms the subscription.",
    ],
  ])("says what ?checkout=%s means", async (checkout, text) => {
    await renderBilling({}, { checkout });
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("data-checkout", checkout);
    expect(status).toHaveTextContent(text);
  });

  it.each([null, "paid", "SUCCESS", ""])(
    "shows nothing for ?checkout=%j (negative)",
    async (checkout) => {
      await renderBilling({}, { checkout });
      expect(screen.queryByRole("status")).toBeNull();
    },
  );
});

describe("Plan tile", () => {
  it("prints the plan name and the billing interval", async () => {
    await renderBilling();
    expect(tile("plan")).toHaveTextContent("build");
    expect(tile("plan")).toHaveTextContent("monthly, cancel any time");
  });

  it("says yearly for a subscription billed annually", async () => {
    await renderBilling({
      plan: readOk({
        subscription: {
          plan: "scale",
          status: "active",
          billingInterval: "year",
          currentPeriodStart: "2026-09-01T00:00:00.000Z",
          currentPeriodEnd: "2027-09-01T00:00:00.000Z",
        },
      }),
    });
    expect(tile("plan")).toHaveTextContent("yearly, cancel any time");
  });

  it("names the tier the contracted rate resolves to for an organization with no subscription", async () => {
    await renderBilling({
      plan: readOk({ subscription: null }),
      rate: readOk(contractRate({ source: "published_tier", tier: "free" })),
    });
    expect(tile("plan")).toHaveTextContent("Free");
    expect(tile("plan")).toHaveTextContent("no subscription");
  });

  it("says not recorded when there is no subscription and the rate could not be read (negative)", async () => {
    await renderBilling({ plan: readOk({ subscription: null }), rate: DOWN });
    expect(tile("plan")).toHaveTextContent("not recorded");
    expect(tile("plan")).toHaveTextContent("no subscription");
  });

  it("shows the read's denial in place of the figure (negative)", async () => {
    await renderBilling({ plan: DENIED });
    expect(
      tile("plan").querySelector("[data-reason=denied]"),
    ).toHaveTextContent("You cannot see Plan for this organization.");
  });
});

describe("GAU tile", () => {
  it("prints what remains this month, and its basis", async () => {
    await renderBilling();
    const gau = tile("gau");
    expect(gau).toHaveAttribute("data-remaining", "38000");
    expect(gau).toHaveTextContent("38,000");
    expect(gau).toHaveTextContent(
      "18,200 used of 50,000 included + 5,000 purchased + 1,200 carried",
    );
  });

  it("prints a fresh month with nothing bought, carried or used as zeros", async () => {
    await renderBilling({
      bucket: readOk(
        prepaidBucket({
          purchasedGau: 0,
          carriedGau: 0,
          usedGau: 0,
          remainingGau: 50000,
        }),
      ),
    });
    expect(tile("gau")).toHaveTextContent(
      "0 used of 50,000 included + 0 purchased + 0 carried",
    );
    expect(tile("gau")).toHaveTextContent("50,000");
  });

  it("prints a negative remainder as overdrawn", async () => {
    await renderBilling({ bucket: readOk(invoiceBucket()) });
    expect(tile("gau")).toHaveTextContent("overdrawn by 112,500");
  });

  it("shows the read's error in place of the figure (negative)", async () => {
    await renderBilling({ bucket: DOWN });
    expect(tile("gau").querySelector("[data-reason=error]")).toHaveTextContent(
      "GAU this month could not be loaded",
    );
  });
});

describe("Contracted rate tile", () => {
  it("prices the published tier's rate per 1,000 GAU, with the block size and source as data", async () => {
    await renderBilling({ rate: readOk(PUBLISHED_BUILD) });
    const rate = tile("rate");
    expect(rate).toHaveAttribute("data-block-size", "5000");
    expect(rate).toHaveAttribute("data-source", "published_tier");
    expect(rate).toHaveTextContent("$5.00");
    expect(rate).toHaveTextContent("per 1,000 GAU");
    expect(rate).toHaveTextContent("Published Build rate");
  });

  it("prices a negotiated agreement, naming its reference", async () => {
    await renderBilling();
    const rate = tile("rate");
    expect(rate).toHaveAttribute("data-block-size", "10000");
    expect(rate).toHaveAttribute("data-source", "negotiated");
    expect(rate).toHaveTextContent("$3.21");
    expect(rate).toHaveTextContent("Negotiated agreement MSA-2026-014");
  });

  it("names a negotiated agreement with no reference generically (negative)", async () => {
    await renderBilling({ rate: readOk(contractRate({ agreementRef: null })) });
    expect(tile("rate")).toHaveTextContent("Negotiated agreement");
    expect(tile("rate")).not.toHaveTextContent("Negotiated agreement M");
  });

  it("shows the read's error in place of the figure (negative)", async () => {
    await renderBilling({ rate: DOWN });
    expect(tile("rate").querySelector("[data-reason=error]")).toHaveTextContent(
      "Contracted rate could not be loaded",
    );
  });
});

describe("Due tile", () => {
  it("says nothing is due and names the next invoice date when no invoice is open", async () => {
    await renderBilling();
    const due = tile("due");
    expect(due).toHaveTextContent("Nothing due");
    expect(due).toHaveTextContent("next invoice Oct 1, 2026");
  });

  it("sums the open invoices at the contracted currency", async () => {
    await renderBilling({
      invoices: invoicePage([
        invoiceRow({ status: "open", amountDue: money("199") }),
        invoiceRow({
          id: "inv_2",
          status: "open",
          amountDue: { micros: "32100000", currency: "USD" },
        }),
        invoiceRow({ id: "inv_3", status: "paid", amountDue: money("50") }),
      ]),
    });
    const due = tile("due");
    expect(due).toHaveAttribute("data-open", "2");
    expect(due).toHaveTextContent("$231.10");
    expect(due).toHaveTextContent("2 open invoices");
    expect(due).toHaveTextContent("USD");
  });

  it("says not recorded for open invoices in more than one currency (negative)", async () => {
    await renderBilling({
      invoices: invoicePage([
        invoiceRow({ status: "open", amountDue: money("199") }),
        invoiceRow({
          id: "inv_2",
          status: "open",
          amountDue: { micros: "32100000", currency: "EUR" },
        }),
      ]),
    });
    const due = tile("due");
    expect(due).toHaveTextContent("not recorded");
    expect(due).toHaveTextContent("open invoices in more than one currency");
  });

  it("shows no next-invoice note when the bucket could not be read (negative)", async () => {
    await renderBilling({ bucket: DOWN, invoices: invoicePage([]) });
    expect(tile("due")).toHaveTextContent("Nothing due");
  });

  it("shows the read's denial in place of the figure (negative)", async () => {
    await renderBilling({ invoices: DENIED });
    expect(
      tile("due").querySelector("[data-reason=denied]"),
    ).toBeInTheDocument();
  });
});

describe("This month", () => {
  it("says nothing was billed yet, naming the free allowance, when no invoice touches the bucket month", async () => {
    await renderBilling({
      invoices: invoicePage([invoiceRow({ status: "void" })]),
    });
    expect(section("This month")).toHaveTextContent(
      "Nothing billed yet this month. The free tier is every feature and 5,000 GAU a month.",
    );
    expect(within(section("This month")).queryByRole("table")).toBeNull();
  });

  it("sums the invoices for each line, printing none for a line with no invoice this month", async () => {
    await renderBilling({
      invoices: invoicePage([
        invoiceRow({ kind: "gau_purchase", amountDue: money("10") }),
        invoiceRow({
          id: "inv_2",
          kind: "gau_purchase",
          amountDue: money("15"),
        }),
      ]),
    });
    const month = section("This month");
    const rows = within(month).getAllByRole("row");
    const [, plan, blocks, topups, overage, tax, total] = rows;
    if (
      plan === undefined ||
      blocks === undefined ||
      topups === undefined ||
      overage === undefined ||
      tax === undefined ||
      total === undefined
    ) {
      throw new Error("expected six line rows");
    }
    expect(plan).toHaveTextContent("Planbuild, billed monthlynone");
    expect(blocks).toHaveTextContent(
      "Blocks bought through Checkout2 invoices$25.00",
    );
    expect(topups).toHaveTextContent("Auto top-upsno invoicesnone");
    expect(overage).toHaveTextContent("Invoiced overageno invoicesnone");
    expect(tax).toHaveTextContent(
      "Taxadded by Stripe on each invoice, not itemised herenot recorded",
    );
    expect(total).toHaveTextContent(
      "Totalthe lines above, as Stripe invoiced them$25.00",
    );
  });

  it("says no subscription in the plan line's basis for an organization with none", async () => {
    await renderBilling({
      plan: readOk({ subscription: null }),
      invoices: invoicePage([
        invoiceRow({ kind: "subscription", amountDue: money("199") }),
      ]),
    });
    expect(
      within(section("This month")).getAllByRole("row")[1],
    ).toHaveTextContent("Planno subscription$199.00");
  });

  it("says the invoices carry more than one currency for a line's amount (negative)", async () => {
    await renderBilling({
      invoices: invoicePage([
        invoiceRow({ kind: "gau_purchase", amountDue: money("10") }),
        invoiceRow({
          id: "inv_2",
          kind: "gau_purchase",
          amountDue: { micros: "15000000", currency: "EUR" },
        }),
      ]),
    });
    const blocks = within(section("This month")).getAllByRole("row")[2];
    expect(blocks).toHaveTextContent("invoices in more than one currency");
  });

  it("notes that the month continues past the newest page, when the oldest row on it is still in the bucket month", async () => {
    await renderBilling({
      invoices: invoicePage(
        [invoiceRow({ kind: "gau_purchase", amountDue: money("10") })],
        "c9",
      ),
    });
    expect(section("This month")).toHaveTextContent(
      "This month continues on the next page of invoices, so the total covers this page only.",
    );
  });

  it("carries no partial-page note when the newest page is not full, or nothing follows it (negative)", async () => {
    await renderBilling({
      invoices: invoicePage([
        invoiceRow({ kind: "gau_purchase", amountDue: money("10") }),
      ]),
    });
    expect(section("This month")).not.toHaveTextContent("This month continues");
  });

  it("shows the read's error in place of the table when the bucket could not be read (negative)", async () => {
    await renderBilling({ bucket: DOWN });
    expect(
      section("This month").querySelector("[data-reason=error]"),
    ).toBeInTheDocument();
    expect(within(section("This month")).queryByRole("table")).toBeNull();
  });

  it("shows the read's error in place of the table when the invoices could not be read (negative)", async () => {
    await renderBilling({ invoices: DOWN });
    expect(
      section("This month").querySelector("[data-reason=error]"),
    ).toBeInTheDocument();
  });
});

describe("Meters", () => {
  it("prints the GAU used of the total, with the period and what remains", async () => {
    await renderBilling();
    const meters = section("Meters");
    const gau = within(meters).getByRole("row", {
      name: /Governed action units/,
    });
    expect(gau).toHaveTextContent("18,200 of 56,200 GAU");
    expect(gau).toHaveTextContent(
      "Sep 1, 2026 – Oct 1, 2026 · 38,000 left · resolve_approval is the only billable governed action, one GAU each",
    );
  });

  it("prints a negative remainder as overdrawn", async () => {
    await renderBilling({ bucket: readOk(invoiceBucket()) });
    expect(
      within(section("Meters")).getByRole("row", {
        name: /Governed action units/,
      }),
    ).toHaveTextContent("overdrawn by 112,500");
  });

  it("reports other governed actions without completion or witness metrics", async () => {
    await renderBilling();
    const meters = section("Meters");
    const other = within(meters).getByRole("row", {
      name: /Other governed actions/,
    });
    expect(other).toHaveTextContent(
      "Other governed actionsnot recordedreported, never priced",
    );
    expect(within(meters).queryByRole("row", { name: /Held runs/ })).toBeNull();
    expect(screen.queryByText(/dod\.held|proven spend/i)).toBeNull();
  });

  it("prints the usage credit balance", async () => {
    await renderBilling({ usageCredits: readOk(usageCredits(4200)) });
    expect(
      within(section("Meters")).getByRole("row", { name: /Usage credits/ }),
    ).toHaveTextContent(
      "Usage credits4,200 creditsbalance for in-app AI usage; 1 credit = $0.01",
    );
  });

  it("shows the credit read's error in its row (negative)", async () => {
    await renderBilling({ usageCredits: DOWN });
    expect(
      within(section("Meters"))
        .getByRole("row", { name: /Usage credits/ })
        .querySelector("[data-reason=error]"),
    ).toBeInTheDocument();
  });

  it("shows the bucket read's error in the GAU row, with no mode and no exhausted line (negative)", async () => {
    await renderBilling({ bucket: DOWN });
    const meters = section("Meters");
    expect(
      within(meters)
        .getByRole("row", { name: /Governed action units/ })
        .querySelector("[data-reason=error]"),
    ).toBeInTheDocument();
    expect(meters.querySelector("[data-mode]")).toBeNull();
    expect(meters.querySelector("[data-exhausted]")).toBeNull();
  });

  describe("billing mode", () => {
    it("states the prepaid rule for an organization with a saved card", async () => {
      await renderBilling();
      const meters = section("Meters");
      expect(meters.querySelector("[data-mode=prepaid]")).toHaveTextContent(
        "Prepaid — governed actions stop when the bucket is empty unless auto top-up refills it",
      );
    });

    it("continues the prepaid line for an organization with no saved payment method", async () => {
      await renderBilling({ bucket: readOk(freeNoCardBucket()) });
      expect(section("Meters")).toHaveTextContent(
        "unless auto top-up refills it — add a payment method to keep governing past the allowance, or wait for the next month",
      );
    });

    it("states invoice billing with the cap and this period's uninvoiced and invoiced counts", async () => {
      await renderBilling({ bucket: readOk(invoiceBucket()) });
      const meters = section("Meters");
      const mode = meters.querySelector("[data-mode=invoice]");
      expect(mode).toHaveTextContent(
        "Invoice billing — usage is never capped; overage is invoiced at period end, or once 100,000 governed action units accrue",
      );
      expect(mode).toHaveTextContent(
        "Uninvoiced this period: 12,500 GAU · Invoiced this period: 100,000 GAU",
      );
      expect(meters.querySelector("[data-past-due]")).toBeNull();
    });

    it("flags a past-due interim or period-close invoice", async () => {
      await renderBilling({
        bucket: readOk(invoiceBucket({ pastDue: true })),
      });
      expect(
        section("Meters").querySelector("[data-past-due]"),
      ).toHaveTextContent(
        "Payment past due: an interim or period-close invoice is open.",
      );
    });
  });

  describe("the exhausted-no-card line", () => {
    it.each([
      ["at zero", 0],
      ["overdrawn", -40],
    ])(
      "tells a Free organization with no card %s to add a payment method or wait for the renewal",
      async (_state, remainingGau) => {
        await renderBilling({
          bucket: readOk(
            freeNoCardBucket({ usedGau: 5000 - remainingGau, remainingGau }),
          ),
        });
        const meters = section("Meters");
        expect(meters.querySelector("[data-exhausted]")).toHaveTextContent(
          "Add a payment method to keep governing this month, or your allowance renews on Oct 1, 2026",
        );
        expect(
          within(meters).getByRole("link", { name: "Add a payment method" }),
        ).toHaveAttribute("href", "#buy-governed-action-units");
      },
    );

    it("is absent while units remain (negative)", async () => {
      await renderBilling({
        bucket: readOk(freeNoCardBucket({ usedGau: 4000, remainingGau: 1000 })),
      });
      expect(section("Meters").querySelector("[data-exhausted]")).toBeNull();
    });

    it("is absent once a card is saved, even at zero (negative)", async () => {
      await renderBilling({
        bucket: readOk(prepaidBucket({ usedGau: 56200, remainingGau: 0 })),
      });
      expect(section("Meters").querySelector("[data-exhausted]")).toBeNull();
    });

    it("is absent in invoice mode (negative)", async () => {
      await renderBilling({ bucket: readOk(invoiceBucket()) });
      expect(section("Meters").querySelector("[data-exhausted]")).toBeNull();
    });
  });
});

describe("Invoices", () => {
  it("lists each invoice with its number, what it charged for, status, period, amounts and hosted page", async () => {
    await renderBilling({
      invoices: invoicePage([
        invoiceRow(),
        invoiceRow({
          id: "inv_9Kd4",
          number: "OXA-0041",
          kind: "subscription",
          status: "open",
          amountDue: { micros: "199000000", currency: "USD" },
          amountPaid: { micros: "0", currency: "USD" },
        }),
      ]),
    });
    const table = within(section("Invoices")).getByRole("table", {
      name: "Invoices",
    });
    const [, first, second] = within(table).getAllByRole("row");
    if (first === undefined || second === undefined)
      throw new Error("expected two invoice rows");
    expect(first).toHaveAttribute("data-kind", "gau_auto_topup");
    expect(first).toHaveTextContent(
      "OXA-0042Sep 1, 2026 – Oct 1, 2026Auto top-up$32.10paid$32.10Open in Stripe",
    );
    expect(second).toHaveAttribute("data-kind", "subscription");
    expect(second).toHaveTextContent(
      "OXA-0041Sep 1, 2026 – Oct 1, 2026Subscription$199.00open$0.00",
    );
    const link = within(first).getByRole("link", { name: "Open in Stripe" });
    expect(link).toHaveAttribute(
      "href",
      "https://invoice.stripe.com/i/acct_1Nx/test_YWNjdF8x",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it.each([
    ["gau_purchase", "Block purchase"],
    ["gau_interim", "Interim"],
    ["gau_period_close", "Period close"],
  ] as const)("names a %s invoice by its kind", async (kind, label) => {
    await renderBilling({ invoices: invoicePage([invoiceRow({ kind })]) });
    expect(
      within(section("Invoices")).getAllByRole("cell")[2],
    ).toHaveTextContent(label);
  });

  it("links no page for an invoice Stripe has not published or a URL off invoice.stripe.com (negative)", async () => {
    await renderBilling({
      invoices: invoicePage([
        invoiceRow({ number: null, hostedInvoiceUrl: null }),
        invoiceRow({
          id: "inv_2Bq8",
          hostedInvoiceUrl: "https://invoice.stripe.com.evil/i/1",
        }),
      ]),
    });
    const invoices = section("Invoices");
    expect(invoices).toHaveTextContent("not assigned");
    expect(within(invoices).getAllByText("not published")).toHaveLength(2);
    expect(within(invoices).queryByRole("link")).toBeNull();
  });

  it("says there are no invoices yet, with no table and no pager", async () => {
    await renderBilling({ invoices: invoicePage([]) });
    const invoices = section("Invoices");
    expect(invoices).toHaveTextContent(/^InvoicesNo invoices yet\.$/);
    expect(within(invoices).queryByRole("table")).toBeNull();
    expect(within(invoices).queryByRole("navigation")).toBeNull();
  });

  it("links the next page of older invoices from the newest page", async () => {
    await renderBilling({ invoices: invoicePage([invoiceRow()], "c3") });
    const pager = within(section("Invoices")).getByRole("navigation", {
      name: "Invoice pages",
    });
    expect(
      within(pager).getByRole("link", { name: "Older invoices" }),
    ).toHaveAttribute("href", "/acme/billing?cursor=c3");
    expect(
      within(pager).queryByRole("link", { name: "Newest invoices" }),
    ).toBeNull();
  });

  it("links back to the newest invoices from an older page", async () => {
    await renderBilling(
      { invoices: invoicePage([invoiceRow()]) },
      { cursor: "c2" },
    );
    const pager = within(section("Invoices")).getByRole("navigation");
    expect(
      within(pager).getByRole("link", { name: "Newest invoices" }),
    ).toHaveAttribute("href", "/acme/billing");
    expect(
      within(pager).queryByRole("link", { name: "Older invoices" }),
    ).toBeNull();
  });

  it("shows the read's error in place of the table (negative)", async () => {
    await renderBilling({ invoices: DOWN });
    expect(
      section("Invoices").querySelector("[data-reason=error]"),
    ).toBeInTheDocument();
    expect(within(section("Invoices")).queryByRole("table")).toBeNull();
  });
});

describe("Usage credits", () => {
  const credits = () => screen.getByRole("region", { name: "Usage credits" });

  // The second meter is metered apart from governed action units, so unlike
  // the GAU sections it is drawn whichever way the organization is billed.
  it.each([
    ["prepaid", () => prepaidBucket()],
    ["invoice-billed", () => invoiceBucket()],
  ])("is drawn for a %s organization", async (_mode, bucket) => {
    await renderBilling({ bucket: readOk(bucket()) });
    expect(credits()).toBeInTheDocument();
    expect(credits()).toHaveTextContent("4,200 credits");
  });

  it.each(["owner", "billing"] as const)(
    "offers an %s the top-up",
    async (role) => {
      await renderBilling({}, { role });
      expect(credits()).toHaveAttribute("data-state", "ok");
      expect(
        within(credits()).getByRole("spinbutton", { name: "Top-up amount" }),
      ).toBeInTheDocument();
    },
  );

  it.each(["admin", "member", "compliance", "viewer"] as const)(
    "shows a %s who can top up instead of the form (negative)",
    async (role) => {
      await renderBilling({}, { role });
      expect(credits()).toHaveAttribute("data-state", "denied");
      expect(within(credits()).queryByRole("spinbutton")).toBeNull();
    },
  );

  // purchase_credits refuses a Free organization at the checkout whatever the
  // role, so offering its owner the form gives them one that cannot succeed.
  it("sends an owner of a Free organization to the subscription, not the form (negative)", async () => {
    await renderBilling(
      {
        rate: readOk(contractRate({ source: "published_tier", tier: "free" })),
      },
      { role: "owner" },
    );
    expect(credits()).toHaveAttribute("data-state", "plan");
    expect(credits()).toHaveTextContent(
      "Usage credits need a Build plan or above.",
    );
    expect(within(credits()).queryByRole("spinbutton")).toBeNull();
  });

  it.each(["build", "scale", "enterprise"] as const)(
    "offers the top-up on the paid tier %s",
    async (tier) => {
      await renderBilling(
        { rate: readOk(contractRate({ tier })) },
        { role: "owner" },
      );
      expect(credits()).toHaveAttribute("data-state", "ok");
    },
  );

  // A rate the page could not read says nothing about the tier, so the form
  // stays offered and the handler stays the authority on it.
  it("still offers the top-up when the rate could not be read", async () => {
    await renderBilling({ rate: DOWN }, { role: "owner" });
    expect(credits()).toHaveAttribute("data-state", "ok");
  });

  it("shows the read's error in place of the balance (negative)", async () => {
    await renderBilling({ usageCredits: DOWN });
    expect(credits().querySelector("[data-reason=error]")).toBeInTheDocument();
  });
});

describe("Buy governed action units", () => {
  const purchase = () =>
    screen.getByRole("region", { name: "Buy governed action units" });

  it.each(["owner", "billing"] as const)(
    "offers an %s the purchase at the rate tile's block size",
    async (role) => {
      await renderBilling({}, { role });
      expect(purchase()).toHaveAttribute("data-state", "ok");
      expect(
        within(purchase()).getByRole("spinbutton", {
          name: "Governed action units",
        }),
      ).toHaveAttribute("step", tile("rate").getAttribute("data-block-size"));
    },
  );

  it.each(["admin", "member", "compliance", "viewer"] as const)(
    "shows a %s who can buy instead of the form (negative)",
    async (role) => {
      await renderBilling({}, { role });
      expect(purchase()).toHaveAttribute("data-state", "denied");
      expect(within(purchase()).queryByRole("spinbutton")).toBeNull();
    },
  );

  it("is not drawn for an invoice-billed organization (negative)", async () => {
    await renderBilling({ bucket: readOk(invoiceBucket()) });
    expect(
      screen.queryByRole("region", { name: "Buy governed action units" }),
    ).toBeNull();
  });
});

describe("Auto top-up", () => {
  it.each(["owner", "admin"] as const)(
    "is editable for an %s",
    async (role) => {
      await renderBilling({}, { role });
      const topup = section("Auto top-up");
      expect(topup).toHaveAttribute("data-editable", "true");
      expect(
        within(topup).getByRole("switch", {
          name: "Top up automatically when the bucket is empty",
        }),
      ).toBeEnabled();
    },
  );

  it.each(["billing", "member", "compliance", "viewer"] as const)(
    "is read-only for a %s (negative)",
    async (role) => {
      await renderBilling({}, { role });
      const topup = section("Auto top-up");
      expect(topup).toHaveAttribute("data-editable", "false");
      expect(within(topup).getByRole("switch")).toBeDisabled();
      expect(topup).toHaveTextContent(
        "An owner or admin can change auto top-up.",
      );
    },
  );

  // The block size reaches the control from the rate read and from nothing
  // else (R3-I6). These two pin that derivation; the control's own test
  // (auto-topup.test.tsx) takes the size as a prop and cannot see where the
  // page got it.
  it("prints the GAUs one top-up buys, from the rate tile's block size", async () => {
    await renderBilling({ bucket: readOk(prepaidBucket({}, { blocks: 3 })) });
    expect(
      section("Auto top-up").querySelector("[data-per-topup]"),
    ).toHaveTextContent("= 30,000 GAU per top-up");
  });

  it("leaves the per-top-up count out when the rate could not be read (negative)", async () => {
    await renderBilling({ rate: DOWN });
    expect(section("Auto top-up").querySelector("[data-per-topup]")).toBeNull();
  });

  it("is not drawn when the bucket could not be read (negative)", async () => {
    await renderBilling({ bucket: DOWN });
    expect(screen.queryByRole("region", { name: "Auto top-up" })).toBeNull();
  });
});

describe("read failures across the page", () => {
  it("shows a Member's denial in place of every read-backed section, with no Auto top-up or purchase form (negative)", async () => {
    await renderBilling(
      {
        plan: DENIED,
        bucket: DENIED,
        rate: DENIED,
        invoices: DENIED,
        usageCredits: DENIED,
      },
      { role: "member" },
    );
    for (const name of ["plan", "gau", "rate", "due"]) {
      expect(
        tile(name).querySelector("[data-reason=denied]"),
      ).toBeInTheDocument();
    }
    for (const name of ["This month", "Invoices", "Usage credits"]) {
      expect(
        section(name).querySelector("[data-reason=denied]"),
      ).toHaveTextContent(
        `You cannot see ${name} for this organization. Your role does not include org.billing`,
      );
    }
    // Meters has no one read of its own: its GAU row fails on the bucket
    // read under its own row label, and its credits row on the usage credit
    // read, each denied separately rather than the whole section at once.
    const meters = section("Meters");
    expect(
      within(meters)
        .getByRole("row", { name: /Governed action units/ })
        .querySelector("[data-reason=denied]"),
    ).toHaveTextContent(
      "You cannot see Governed action units for this organization. Your role does not include org.billing",
    );
    expect(
      within(meters)
        .getByRole("row", { name: /Usage credits/ })
        .querySelector("[data-reason=denied]"),
    ).toHaveTextContent(
      "You cannot see Usage credits for this organization. Your role does not include org.billing",
    );
    expect(screen.queryByRole("region", { name: "Auto top-up" })).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Buy governed action units" }),
    ).toBeNull();
    // Meters keeps its table: the other-actions row is never
    // priced and so cannot fail. This month and Invoices have no table.
    expect(within(section("This month")).queryByRole("table")).toBeNull();
    expect(within(section("Invoices")).queryByRole("table")).toBeNull();
  });

  it("shows the error code in place of every read-backed section's figures (negative)", async () => {
    await renderBilling({
      plan: DOWN,
      bucket: DOWN,
      rate: DOWN,
      invoices: DOWN,
      usageCredits: DOWN,
    });
    for (const name of ["This month", "Invoices", "Usage credits"]) {
      expect(
        section(name).querySelector("[data-reason=error]"),
      ).toHaveTextContent(
        `${name} could not be loaded: the billing service answered stripe_unreachable`,
      );
    }
    const meters = section("Meters");
    expect(
      within(meters)
        .getByRole("row", { name: /Governed action units/ })
        .querySelector("[data-reason=error]"),
    ).toHaveTextContent(
      "Governed action units could not be loaded: the billing service answered stripe_unreachable",
    );
  });

  it("shows an access request still waiting for approval (negative)", async () => {
    await renderBilling({
      plan: {
        ok: false,
        reason: "pending_approval",
        accessRequestId: "ar_7Qx",
      },
    });
    expect(
      tile("plan").querySelector("[data-reason=pending_approval]"),
    ).toHaveTextContent(
      "Access to Plan is waiting for approval, request ar_7Qx.",
    );
  });
});
