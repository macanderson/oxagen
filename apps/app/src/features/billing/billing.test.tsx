// @vitest-environment jsdom
// The Billing page over a fake DataSource: the checkout banner, Plan, Billing
// mode, the governed action bucket, Auto top-up and Invoices, each in its ok,
// empty, denied and error states, for a prepaid and an invoice-billed
// organization, with an axe check in every one. The rate block's own states
// are in contract-rate.test.tsx.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrgRole } from "@/data/contracts/common";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  type BillingReads,
  billingSource,
  freeNoCardBucket,
  invoiceBucket,
  invoicePage,
  invoiceRow,
  prepaidBucket,
} from "./billing.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
// The auto top-up save is the control's own test (auto-topup.test.tsx).
vi.mock("./actions", () => ({ setAutoTopup: vi.fn() }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Billing } = await import("./billing");

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
  reads: Partial<BillingReads> = {},
  options: {
    role?: OrgRole;
    checkout?: string | null;
    cursor?: string | null;
  } = {},
) {
  const ctx = viewer(options.role ?? "owner");
  const { source, calls } = billingSource(reads);
  const element = await Billing({
    ctx,
    source,
    checkout: options.checkout ?? null,
    cursor: options.cursor ?? null,
  });
  render(<IntlProvider>{element}</IntlProvider>);
  return { ctx, calls };
}

const section = (name: string) => screen.getByRole("region", { name });
const fact = (region: HTMLElement, name: string) => {
  const found = region.querySelector(`[data-fact="${name}"] dd`);
  if (found === null) throw new Error(`no ${name} fact`);
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

describe("Billing reads", () => {
  it("reads the plan, the bucket, the rate and the invoices page at the URL's cursor, once each", async () => {
    const { ctx, calls } = await renderBilling({}, { cursor: "c2" });
    expect(calls).toEqual({
      plan: [[ctx]],
      bucket: [[ctx]],
      rate: [[ctx]],
      invoices: [[ctx, { cursor: "c2" }]],
    });
  });

  it("draws the sections in the order of §1.4", async () => {
    await renderBilling();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual([
      "Plan",
      "Billing mode",
      "Governed action bucket",
      "Auto top-up",
      "Your contracted rate",
      "Invoices",
    ]);
  });
});

describe("checkout banner", () => {
  it.each([
    [
      "success",
      "Checkout finished. The governed action units you bought are added to the bucket once Stripe confirms the payment.",
    ],
    ["cancel", "Checkout was cancelled. Nothing was charged."],
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

describe("Plan", () => {
  it("prints the plan, status, billing interval and current period", async () => {
    await renderBilling();
    const plan = section("Plan");
    expect(fact(plan, "plan")).toHaveTextContent(/^build$/);
    expect(fact(plan, "status")).toHaveTextContent(/^active$/);
    expect(fact(plan, "interval")).toHaveTextContent(/^monthly$/);
    expect(fact(plan, "period")).toHaveTextContent(
      /^Sep 1, 2026 – Oct 1, 2026$/,
    );
  });

  it("prints No subscription and nothing else for an organization with none", async () => {
    await renderBilling({ plan: readOk({ subscription: null }) });
    expect(section("Plan")).toHaveTextContent(/^PlanNo subscription$/);
  });
});

describe("Billing mode", () => {
  it("states the prepaid rule for an organization with a saved card, with no invoice counts", async () => {
    await renderBilling();
    const mode = section("Billing mode");
    expect(mode).toHaveAttribute("data-mode", "prepaid");
    expect(mode).toHaveTextContent(
      /^Billing modePrepaid — governed actions stop when the bucket is empty unless auto top-up refills it$/,
    );
    expect(mode.querySelector("[data-fact]")).toBeNull();
  });

  it("continues the prepaid line for an organization with no saved payment method", async () => {
    await renderBilling({ bucket: readOk(freeNoCardBucket()) });
    expect(section("Billing mode")).toHaveTextContent(
      "unless auto top-up refills it — add a payment method to keep governing past the allowance, or wait for the next month",
    );
  });

  it("states invoice billing with the cap and this period's uninvoiced and invoiced counts", async () => {
    await renderBilling({ bucket: readOk(invoiceBucket()) });
    const mode = section("Billing mode");
    expect(mode).toHaveAttribute("data-mode", "invoice");
    expect(mode).toHaveTextContent(
      "Invoice billing — usage is never capped; overage is invoiced at period end, or once 100,000 governed action units accrue",
    );
    expect(fact(mode, "uninvoiced")).toHaveTextContent(/^12,500 GAU$/);
    expect(fact(mode, "invoiced")).toHaveTextContent(/^100,000 GAU$/);
    expect(mode.querySelector("[data-past-due]")).toBeNull();
  });

  it("flags a past-due interim or period-close invoice", async () => {
    await renderBilling({ bucket: readOk(invoiceBucket({ pastDue: true })) });
    expect(
      section("Billing mode").querySelector("[data-past-due]"),
    ).toHaveTextContent(
      "Payment past due: an interim or period-close invoice is open.",
    );
  });
});

describe("Governed action bucket", () => {
  it("prints this month's period and its counts, and no money", async () => {
    await renderBilling();
    const bucket = section("Governed action bucket");
    expect(fact(bucket, "period")).toHaveTextContent(
      /^Sep 1, 2026 – Oct 1, 2026$/,
    );
    expect(fact(bucket, "included")).toHaveTextContent(/^50,000 GAU$/);
    expect(fact(bucket, "purchased")).toHaveTextContent(/^5,000 GAU$/);
    expect(fact(bucket, "carried")).toHaveTextContent(/^1,200 GAU$/);
    expect(fact(bucket, "used")).toHaveTextContent(/^18,200 GAU$/);
    expect(fact(bucket, "remaining")).toHaveTextContent(/^38,000 GAU$/);
    expect(bucket.querySelector("[data-exhausted]")).toBeNull();
    expect(within(bucket).queryByTestId("money")).toBeNull();
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
    const bucket = section("Governed action bucket");
    expect(fact(bucket, "purchased")).toHaveTextContent(/^0 GAU$/);
    expect(fact(bucket, "carried")).toHaveTextContent(/^0 GAU$/);
    expect(fact(bucket, "used")).toHaveTextContent(/^0 GAU$/);
    expect(fact(bucket, "remaining")).toHaveTextContent(/^50,000 GAU$/);
  });

  it("prints a negative remainder as overdrawn", async () => {
    await renderBilling({ bucket: readOk(invoiceBucket()) });
    expect(
      fact(section("Governed action bucket"), "remaining"),
    ).toHaveTextContent(/^overdrawn by 112,500 GAU$/);
  });

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
      const bucket = section("Governed action bucket");
      expect(bucket.querySelector("[data-exhausted]")).toHaveTextContent(
        /^Add a payment method to keep governing this month, or your allowance renews on Oct 1, 2026$/,
      );
      expect(
        within(bucket).getByRole("link", { name: "Add a payment method" }),
      ).toHaveAttribute("href", "#buy-governed-action-units");
    },
  );

  it("does not draw the exhausted line while units remain (negative)", async () => {
    await renderBilling({
      bucket: readOk(freeNoCardBucket({ usedGau: 4000, remainingGau: 1000 })),
    });
    expect(
      section("Governed action bucket").querySelector("[data-exhausted]"),
    ).toBeNull();
  });

  it("does not draw the exhausted line once a card is saved; the auto top-up state shows instead (negative)", async () => {
    await renderBilling({
      bucket: readOk(prepaidBucket({ usedGau: 56200, remainingGau: 0 })),
    });
    expect(
      section("Governed action bucket").querySelector("[data-exhausted]"),
    ).toBeNull();
    expect(
      section("Auto top-up").querySelector("[data-card=saved]"),
    ).toHaveTextContent("charged to visa ····4242");
  });

  it("does not draw the exhausted line in invoice mode (negative)", async () => {
    await renderBilling({ bucket: readOk(invoiceBucket()) });
    expect(
      section("Governed action bucket").querySelector("[data-exhausted]"),
    ).toBeNull();
  });
});

describe("Auto top-up", () => {
  it.each(["owner", "admin"] as const)(
    "is editable for an %s, with no money",
    async (role) => {
      await renderBilling({}, { role });
      const topup = section("Auto top-up");
      expect(topup).toHaveAttribute("data-editable", "true");
      const toggle = within(topup).getByRole("switch", {
        name: "Top up automatically when the bucket is empty",
      });
      expect(toggle).toBeEnabled();
      expect(toggle).toBeChecked();
      const stepper = within(topup).getByRole("spinbutton", {
        name: "Blocks per top-up",
      });
      expect(stepper).toBeEnabled();
      expect(stepper).toHaveValue(1);
      expect(topup).not.toHaveTextContent("An owner or admin");
      expect(within(topup).queryByTestId("money")).toBeNull();
    },
  );

  it.each(["billing", "member", "compliance", "viewer"] as const)(
    "is read-only for a %s (negative)",
    async (role) => {
      await renderBilling({}, { role });
      const topup = section("Auto top-up");
      expect(topup).toHaveAttribute("data-editable", "false");
      expect(within(topup).getByRole("switch")).toBeDisabled();
      expect(within(topup).getByRole("spinbutton")).toBeDisabled();
      expect(topup).toHaveTextContent(
        "An owner or admin can change auto top-up.",
      );
    },
  );
});

describe("Invoices", () => {
  it("lists each invoice with its number, kind, status, period, amounts and hosted page", async () => {
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
      "OXA-0042Auto top-uppaidSep 1, 2026 – Oct 1, 2026$32.10$32.10View on Stripe",
    );
    expect(second).toHaveAttribute("data-kind", "subscription");
    expect(second).toHaveTextContent(
      "OXA-0041SubscriptionopenSep 1, 2026 – Oct 1, 2026$199.00$0.00",
    );
    const link = within(first).getByRole("link", {
      name: "View on Stripe",
    });
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
      within(section("Invoices")).getAllByRole("cell")[1],
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

  it("links back to the newest invoices from the last page", async () => {
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
});

describe("a read that returns no value", () => {
  const SECTIONS = [
    "Plan",
    "Billing mode",
    "Governed action bucket",
    "Your contracted rate",
    "Invoices",
  ];

  it("shows a Member's denial in place of every section's figures, and no auto top-up (negative)", async () => {
    await renderBilling(
      { plan: DENIED, bucket: DENIED, rate: DENIED, invoices: DENIED },
      { role: "member" },
    );
    for (const name of SECTIONS) {
      expect(
        section(name).querySelector("[data-reason=denied]"),
      ).toHaveTextContent(
        `You cannot see ${name} for this organization. Your role does not include org.billing`,
      );
    }
    expect(screen.queryByRole("region", { name: "Auto top-up" })).toBeNull();
    expect(screen.queryByTestId("money")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows the error code in place of every section's figures, and no auto top-up (negative)", async () => {
    await renderBilling({
      plan: DOWN,
      bucket: DOWN,
      rate: DOWN,
      invoices: DOWN,
    });
    for (const name of SECTIONS) {
      expect(
        section(name).querySelector("[data-reason=error]"),
      ).toHaveTextContent(
        `${name} could not be loaded: the billing service answered stripe_unreachable`,
      );
    }
    expect(screen.queryByRole("region", { name: "Auto top-up" })).toBeNull();
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
      section("Plan").querySelector("[data-reason=pending_approval]"),
    ).toHaveTextContent(
      "Access to Plan is waiting for approval, request ar_7Qx.",
    );
  });
});
