// @vitest-environment jsdom
// The Billing page (oxagen-roadmap mockups/pages/billing.md) over a fake
// DataSource: the six reads it makes (and the newest invoices page when the
// URL is on an older one), the header and its one gold action, the four tiles
// and how they reconcile with This period, the five meters, Invoices, the
// price list, Billable units, the controls that buy through Stripe, the
// checkout banner, and the empty, error, denied and pending states with the
// design's copy verbatim, with an axe check in every one (INV-26). The
// controls' own interactions have their own test files (auto-topup,
// purchase-form, usage-credits, change-plan); this file covers the page-level
// derivations that feed them.
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
  evidenceRetention,
  freeNoCardBucket,
  invoiceBucket,
  invoicePage,
  invoiceRow,
  PUBLISHED_BUILD,
  prepaidBucket,
  SUBSCRIPTION,
} from "./billing.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
// Each write is tested through its own control. Every mock lives in one
// factory because a second vi.mock of the same path replaces the first.
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
const { Billing } = await import("./billing");
const { BillingSkeleton } = await import("./states");

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
const usd = (micros: string) => ({ micros, currency: "USD" });

/**
 * The loaded record the design is drawn from, in this codebase's figures: a
 * Build subscription, 159 blocks of 10,000 bought at $32.10 a block past a
 * 250,000 allowance, and September's $199.00 plan invoice.
 */
const LOADED: Partial<BillingReads> = {
  bucket: readOk(
    prepaidBucket({
      includedGau: 250_000,
      purchasedGau: 1_590_000,
      carriedGau: 0,
      usedGau: 1_837_838,
      remainingGau: 2_162,
    }),
  ),
  invoices: invoicePage([
    invoiceRow({
      id: "inv_9Kd4",
      number: "OXA-0043",
      kind: "subscription",
      amountDue: usd("199000000"),
      amountPaid: usd("199000000"),
    }),
    invoiceRow({
      id: "inv_8Ab2",
      number: "OXA-0042",
      kind: "gau_purchase",
      status: "open",
      amountDue: usd("5103900000"),
      amountPaid: usd("0"),
    }),
  ]),
};

async function renderBilling(
  reads: Partial<BillingReads> & {
    newestInvoices?: BillingReads["invoices"];
  } = LOADED,
  options: {
    role?: OrgRole;
    checkout?: string | null;
    cursor?: string | null;
  } = {},
) {
  const ctx = viewer(options.role ?? "owner");
  const { source, calls } = billingSource(reads);
  const body = await Billing({
    ctx,
    source,
    title: "Billing",
    checkout: options.checkout ?? null,
    cursor: options.cursor ?? null,
  });
  render(<IntlProvider>{body}</IntlProvider>);
  return { ctx, calls };
}

const section = (name: string) => screen.getByRole("region", { name });
/** A summary tile by its stable `data-tile` name (Tile, summary.tsx). */
const tile = (name: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-tile="${name}"]`);
  if (found === null) throw new Error(`no ${name} tile`);
  return found;
};
/** A row of a panel's table by its `data-*` name. */
const row = (attr: string, name: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[${attr}="${name}"]`);
  if (found === null) throw new Error(`no ${attr}=${name}`);
  return found;
};
const headers = (table: HTMLElement) =>
  within(table)
    .getAllByRole("columnheader")
    .map((th) => th.textContent);
/** The gold buttons and links on the page: the design allows exactly one. */
const gold = () =>
  [...document.querySelectorAll("button, a")].filter((el) =>
    el.className.includes("bg-button-primary-bg"),
  );

afterEach(async () => {
  // INV-26: every test ends in a state of the page; axe checks it.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("reads", () => {
  it("reads the plan, the bucket, the rate, the retention terms, the newest invoices page and the token balance once each", async () => {
    const { ctx, calls } = await renderBilling();
    expect(calls.plan).toEqual([[ctx]]);
    expect(calls.bucket).toEqual([[ctx]]);
    expect(calls.rate).toEqual([[ctx]]);
    expect(calls.retention).toEqual([[ctx]]);
    expect(calls.usageCredits).toEqual([[ctx]]);
    expect(calls.invoices).toEqual([[ctx, { cursor: null }]]);
  });

  it("also reads the newest invoices page when the URL asks for an older one, and rolls the statement up from it", async () => {
    const { ctx, calls } = await renderBilling(
      {
        ...LOADED,
        invoices: invoicePage([
          invoiceRow({
            kind: "subscription",
            periodStart: "2026-07-01T00:00:00.000Z",
            periodEnd: "2026-08-01T00:00:00.000Z",
          }),
        ]),
        newestInvoices: LOADED.invoices,
      },
      { cursor: "c2" },
    );
    expect(calls.invoices).toEqual([
      [ctx, { cursor: "c2" }],
      [ctx, { cursor: null }],
    ]);
    expect(row("data-line", "plan")).toHaveTextContent("$199.00");
  });
});

describe("header", () => {
  it("names the page with the eyebrow and the one-sentence subtext", async () => {
    await renderBilling();
    expect(
      screen.getByRole("heading", { level: 1, name: "Billing" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Organization")).toBeInTheDocument();
    expect(
      screen.getByText("What Acme Robotics pays Oxagen."),
    ).toBeInTheDocument();
  });

  it("carries exactly one gold action, Change plan", async () => {
    await renderBilling();
    expect(gold().map((el) => el.textContent)).toEqual(["Change plan"]);
  });

  it("opens the plan dialog to the subscribed sentence for an owner whose organization already has a plan", async () => {
    await renderBilling();
    await userEvent.click(screen.getByRole("button", { name: "Change plan" }));
    expect(
      screen.getByRole("dialog", { name: "Change plan" }),
    ).toHaveTextContent("This organization already has a build subscription.");
  });

  it("opens the plan dialog to the role-denied sentence for a member (negative)", async () => {
    await renderBilling(LOADED, { role: "member" });
    await userEvent.click(screen.getByRole("button", { name: "Change plan" }));
    expect(
      screen.getByRole("dialog", { name: "Change plan" }),
    ).toHaveTextContent("An owner or a billing member can change the plan.");
  });

  it("opens the plan dialog to the Plan select for an owner with no subscription", async () => {
    await renderBilling({ ...LOADED, plan: readOk({ subscription: null }) });
    await userEvent.click(screen.getByRole("button", { name: "Change plan" }));
    const dialog = screen.getByRole("dialog", { name: "Change plan" });
    expect(
      within(dialog).getByRole("combobox", { name: "Plan" }),
    ).toBeInTheDocument();
  });
});

describe("section order", () => {
  it("draws the tiles, then This period, Meters and Invoices, then the price list, Billable units and the controls that buy through Stripe", async () => {
    await renderBilling();
    const regions = screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-labelledby"));
    expect(regions).toEqual([
      "billing-this-period",
      "billing-meters",
      "billing-invoices",
      "billing-price-list",
      "billing-billable-units",
      "billing-auto-topup",
      "billing-buy",
      "billing-usage-credits",
    ]);
    expect(
      [...document.querySelectorAll("[data-tile]")].map((el) =>
        el.getAttribute("data-tile"),
      ),
    ).toEqual(["plan", "governed", "retained", "due"]);
  });
});

describe("summary tiles", () => {
  it("prints the plan and its basis", async () => {
    await renderBilling();
    expect(tile("plan")).toHaveTextContent("Planbuildmonthly, cancel any time");
  });

  it("says yearly for a subscription billed annually", async () => {
    await renderBilling({
      ...LOADED,
      plan: readOk({
        subscription: { ...SUBSCRIPTION, billingInterval: "year" },
      }),
    });
    expect(tile("plan")).toHaveTextContent("yearly, cancel any time");
  });

  it("names the tier the contracted rate resolves to when there is no subscription", async () => {
    await renderBilling({
      ...LOADED,
      plan: readOk({ subscription: null }),
      rate: readOk(PUBLISHED_BUILD),
    });
    expect(tile("plan")).toHaveTextContent("PlanBuildno subscription");
  });

  it("prints the governed actions past the allowance, with the blocks and the allowance as its basis", async () => {
    await renderBilling();
    expect(tile("governed")).toHaveTextContent(
      "Governed actions this period1,587,838above the included allowance · 159 blocks × $32.10 · 250,000 included",
    );
  });

  it("says the retained evidence volume is not recorded, with the included window", async () => {
    await renderBilling();
    expect(tile("retained")).toHaveTextContent(
      "Retained evidencenot recorded12 months included",
    );
    expect(
      tile("retained").querySelector("[data-recorded=false]"),
    ).not.toBeNull();
  });

  it("prints what is due at the period's end, in its currency, after the onboarding discount", async () => {
    await renderBilling();
    expect(tile("due")).toHaveTextContent(
      "Due Oct 1, 2026$5,302.90USD · after the onboarding discount",
    );
  });

  it("shows a read's refusal in the tiles that read it (negative)", async () => {
    await renderBilling({ ...LOADED, rate: DOWN });
    expect(
      tile("governed").querySelector("[data-reason=error]"),
    ).toBeInTheDocument();
    expect(
      tile("due").querySelector("[data-reason=error]"),
    ).toBeInTheDocument();
    expect(tile("plan")).toHaveTextContent("build");
  });
});

describe("figures reconcile", () => {
  it("rolls the tiles up from the lines of This period", async () => {
    await renderBilling();
    // The governed tile is the count on the first line.
    expect(row("data-line", "governed")).toHaveTextContent(
      "Governed actions 1 – 1,587,838",
    );
    // Blocks × block price is the line's amount: 159 × $32.10 = $5,103.90.
    expect(row("data-line", "governed")).toHaveTextContent("$5,103.90");
    // Due is the Total.
    expect(row("data-line", "total")).toHaveTextContent("$5,302.90 USD");
    // Retention reads the same on the tile, the line and the meter.
    expect(row("data-line", "retention")).toHaveTextContent(
      "12 months included · GB held not recorded",
    );
    expect(row("data-meter", "retained")).toHaveTextContent(
      "not recorded12 months included",
    );
  });
});

describe("This period", () => {
  it("carries the badge and the columns Line, Basis and Amount", async () => {
    await renderBilling();
    const panel = section("This period");
    expect(panel).toHaveTextContent("Stripe invoices, Oxagen meter");
    expect(headers(within(panel).getByRole("table"))).toEqual([
      "Line",
      "Basis",
      "Amount",
    ]);
  });

  it("lists governed actions, the plan, tokens, evidence retention, the onboarding discount and the total", async () => {
    await renderBilling();
    const lines = [...section("This period").querySelectorAll("tbody tr")].map(
      (tr) => tr.getAttribute("data-line"),
    );
    expect(lines).toEqual([
      "governed",
      "plan",
      "tokens",
      "retention",
      "discount",
      "total",
    ]);
    expect(row("data-line", "plan")).toHaveTextContent(
      "Planbuild, billed monthly · 1 Stripe invoice$199.00",
    );
    expect(row("data-line", "tokens")).toHaveTextContent(
      "Tokensreported at zero · the customer’s own model spend is on Spend$0.00",
    );
    expect(row("data-line", "retention")).toHaveTextContent("$0.00");
    expect(row("data-line", "discount")).toHaveTextContent(
      "Onboarding discountno onboarding offer is recorded for this organizationnot recorded",
    );
    expect(row("data-line", "total")).toHaveTextContent(
      "Totalrounded to cents once, half-even$5,302.90 USD",
    );
  });

  it("leaves the plan line off for an organization with no subscription", async () => {
    await renderBilling({ ...LOADED, plan: readOk({ subscription: null }) });
    expect(document.querySelector('[data-line="plan"]')).toBeNull();
    expect(row("data-line", "total")).toHaveTextContent("$5,103.90 USD");
  });

  it("names the line plainly when nothing is past the allowance", async () => {
    await renderBilling({
      ...LOADED,
      bucket: readOk(prepaidBucket({ purchasedGau: 0 })),
    });
    expect(row("data-line", "governed")).toHaveTextContent(
      "Governed actions0 blocks × $32.10 · 50,000 included$0.00",
    );
  });

  it("prices invoice-billed overage at the per-action rate", async () => {
    await renderBilling({
      ...LOADED,
      bucket: readOk(invoiceBucket()),
      rate: readOk(PUBLISHED_BUILD),
    });
    expect(row("data-line", "governed")).toHaveTextContent(
      "Governed actions 1 – 112,500112,500 at $0.005 each · 300,000 included$562.50",
    );
  });

  it("says retention and the total are not recorded once extended retention is on (negative)", async () => {
    await renderBilling({
      ...LOADED,
      retention: readOk(evidenceRetention({ extendedRetentionEnabled: true })),
    });
    expect(row("data-line", "retention")).toHaveTextContent(
      "extended retention onnot recorded",
    );
    expect(row("data-line", "total")).toHaveTextContent("not recorded");
    expect(tile("due")).toHaveTextContent("not recorded");
  });

  it("shows the read's error in place of the table when the rate could not be read (negative)", async () => {
    await renderBilling({ ...LOADED, rate: DOWN });
    expect(
      section("This period").querySelector("[data-reason=error]"),
    ).toHaveTextContent(
      "This period could not be loaded: the billing service answered stripe_unreachable. Nothing was charged.",
    );
  });
});

describe("Meters", () => {
  it("lists the five meters in the design's order under Meter, This period and Note, with the note", async () => {
    await renderBilling();
    const meters = section("Meters");
    expect(headers(within(meters).getByRole("table"))).toEqual([
      "Meter",
      "This period",
      "Note",
    ]);
    expect(
      [...meters.querySelectorAll("tbody tr")].map((tr) => tr.textContent),
    ).toEqual([
      "Governed actions1,837,838the billable unit · 250,000 included this month",
      "Sealed runs with at least one model callnot recordedreported, not priced",
      "Retained evidencenot recorded12 months included",
      "Runs Oxagen halted before any model callnot recordedfree",
      "Runs of the in-app agentnot recordedfree",
    ]);
    expect(meters).toHaveTextContent(
      "One priced meter: the governed action, a call Oxagen decided, delivered and recorded. Runs, tokens and retained evidence are reported so the price can move later without rewriting the meter.",
    );
  });

  it("states the prepaid rule for an organization with a saved card", async () => {
    await renderBilling();
    expect(section("Meters").querySelector("[data-mode]")).toHaveTextContent(
      "Prepaid. Governed actions stop when this period's allowance runs out, unless auto top-up buys more.",
    );
  });

  it("states invoice billing with the cap and this period's counts, and a past-due invoice", async () => {
    await renderBilling({
      ...LOADED,
      bucket: readOk(invoiceBucket({ pastDue: true })),
    });
    const meters = section("Meters");
    expect(meters.querySelector("[data-mode=invoice]")).toHaveTextContent(
      "Invoice billing. Governed actions are never capped. Overage is invoiced at period end, or once 100,000 governed actions accrue.",
    );
    expect(meters.querySelector("[data-fact=uninvoiced]")).toHaveTextContent(
      "Not invoiced yet this period: 12,500 governed actions. Invoiced this period: 100,000 governed actions.",
    );
    expect(meters.querySelector("[data-past-due]")).toBeInTheDocument();
    expect(meters.querySelector("[data-overdrawn]")).toHaveTextContent(
      "112,500 past what this period holds",
    );
  });

  it("links a Free organization spent to zero with no card to the purchase form", async () => {
    await renderBilling({
      ...LOADED,
      plan: readOk({ subscription: null }),
      bucket: readOk(freeNoCardBucket()),
    });
    const line = section("Meters").querySelector("[data-exhausted]");
    expect(line).toHaveTextContent(
      "Add a payment method to keep governing this month, or your allowance renews on Oct 1, 2026",
    );
    expect(
      within(line as HTMLElement).getByRole("link", {
        name: "Add a payment method",
      }),
    ).toHaveAttribute("href", "#billing-buy");
  });

  it("shows no exhausted line while a period still has room (negative)", async () => {
    await renderBilling();
    expect(section("Meters").querySelector("[data-exhausted]")).toBeNull();
  });

  it("shows the retention read's error in its row (negative)", async () => {
    await renderBilling({ ...LOADED, retention: DOWN });
    expect(
      row("data-meter", "retained").querySelector("[data-reason=error]"),
    ).toBeInTheDocument();
  });
});

describe("Invoices", () => {
  it("lists each invoice under the design's columns with a status dot and word and the Stripe page", async () => {
    await renderBilling();
    const table = within(section("Invoices")).getByRole("table");
    expect(headers(table)).toEqual([
      "Invoice",
      "Period",
      "Governed actions",
      "Amount",
      "Status",
      "Paid",
      "Open in Stripe",
    ]);
    const [, first, second] = within(table).getAllByRole("row");
    if (first === undefined || second === undefined)
      throw new Error("expected two invoice rows");
    expect(first).toHaveTextContent(
      "OXA-0043Sep 1, 2026 – Oct 1, 2026not recorded$199.00paid$199.00Open in Stripe ↗",
    );
    expect(second).toHaveAttribute("data-status", "open");
    expect(second).toHaveTextContent("open$0.00");
    const link = within(first).getByRole("link", {
      name: "Open invoice OXA-0043 on stripe.com in a new tab",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://invoice.stripe.com/i/acct_1Nx/test_YWNjdF8x",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("links no page for an invoice Stripe has not published or a URL off invoice.stripe.com (negative)", async () => {
    await renderBilling({
      ...LOADED,
      invoices: invoicePage([
        invoiceRow({ hostedInvoiceUrl: null }),
        invoiceRow({
          id: "inv_2",
          hostedInvoiceUrl: "https://evil.example/i/x",
        }),
      ]),
    });
    expect(within(section("Invoices")).queryByRole("link")).toBeNull();
    expect(section("Invoices")).toHaveTextContent("not published");
  });

  it("says there are no invoices yet, with no table and no pager", async () => {
    await renderBilling({ ...LOADED, invoices: invoicePage([]) });
    expect(section("Invoices")).toHaveTextContent("No invoices yet.");
    expect(within(section("Invoices")).queryByRole("table")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("links the next page of older invoices from the newest page, and back", async () => {
    await renderBilling({
      ...LOADED,
      invoices: invoicePage([invoiceRow()], "c2"),
    });
    expect(
      screen.getByRole("link", { name: "Older invoices" }),
    ).toHaveAttribute("href", "/acme/billing?cursor=c2");
    cleanup();
    await renderBilling(
      { ...LOADED, invoices: invoicePage([invoiceRow()]) },
      { cursor: "c2" },
    );
    expect(
      screen.getByRole("link", { name: "Newest invoices" }),
    ).toHaveAttribute("href", "/acme/billing");
  });

  it("shows the read's error in place of the table (negative)", async () => {
    await renderBilling({ ...LOADED, invoices: DOWN });
    expect(
      section("Invoices").querySelector("[data-reason=error]"),
    ).toBeInTheDocument();
  });
});

describe("Price list", () => {
  it("lists the seven published terms and the footer, every figure read", async () => {
    await renderBilling();
    const list = section("Price list");
    expect(
      [...list.querySelectorAll("tr")].map((tr) => tr.textContent),
    ).toEqual([
      "Freeevery governance feature, 5,000 governed actions a month",
      "Governed actions, blocks of 5,000$25.00 per block at the published rate",
      "Negotiated agreementthe same four figures, per organization",
      "Invoice billingnever capped · overage invoiced at the contracted rate at period end",
      "Evidence retention12 months included on paid plans, then $0.08 per GB-month",
      "Tokens Oxagen buys for youat cost, no markup, capped",
      "Enterprise, annualnegotiated per organization",
    ]);
    expect(list).toHaveTextContent(
      "No credits, no resellers, and no revenue dashboard. The free tier is the whole product, limited by retention and seats, never by features or volume. Upgrading is a governance decision, not a volume accident.",
    );
  });

  it("shows the retention read's error on its row (negative)", async () => {
    await renderBilling({ ...LOADED, retention: DOWN });
    expect(
      row("data-price", "retention").querySelector("[data-reason=error]"),
    ).toBeInTheDocument();
  });
});

describe("Billable units", () => {
  it("names what is priced, reported and free", async () => {
    await renderBilling();
    expect(
      [...section("Billable units").querySelectorAll("li")].map(
        (li) => li.textContent,
      ),
    ).toEqual([
      "PricedA governed action: a call Oxagen decided, delivered and recorded, with its receipt in the chain.",
      "ReportedSealed runs, tokens by class, retained evidence: secondary meters, never priced.",
      "FreeDenials, runs Oxagen halted before a model call, runs of the in-app agent. You never pay for Oxagen saying no.",
    ]);
  });
});

describe("checkout banner", () => {
  it.each([
    [
      "success",
      "Checkout finished. The governed actions you bought are added to this period once Stripe confirms the payment.",
    ],
    ["cancel", "Checkout was cancelled. Nothing was charged."],
    [
      "credits",
      "Checkout finished. The top-up is added to the token balance once Stripe confirms the payment.",
    ],
    [
      "plan",
      "Checkout finished. The new plan applies once Stripe confirms the subscription.",
    ],
  ])("says what ?checkout=%s means", async (checkout, text) => {
    await renderBilling(LOADED, { checkout });
    const status = document.querySelector(`[data-checkout="${checkout}"]`);
    expect(status).toHaveTextContent(text);
  });

  it.each([null, "paid", "SUCCESS", ""])(
    "shows nothing for ?checkout=%j (negative)",
    async (checkout) => {
      await renderBilling(LOADED, { checkout });
      expect(document.querySelector("[data-checkout]")).toBeNull();
    },
  );
});

describe("the controls that buy through Stripe", () => {
  it.each(["owner", "billing"] as const)(
    "offers an %s the purchase, stepping by the contracted block size",
    async (role) => {
      await renderBilling(LOADED, { role });
      const buy = section("Buy governed actions");
      expect(buy).toHaveAttribute("data-state", "ok");
      expect(
        within(buy).getByRole("spinbutton", { name: "Governed actions" }),
      ).toHaveAttribute("step", "10000");
    },
  );

  it.each(["admin", "member", "compliance", "viewer"] as const)(
    "shows a %s who can buy instead of the form (negative)",
    async (role) => {
      await renderBilling(LOADED, { role });
      const buy = section("Buy governed actions");
      expect(buy).toHaveAttribute("data-state", "denied");
      expect(within(buy).queryByRole("spinbutton")).toBeNull();
    },
  );

  it("draws no purchase form for an invoice-billed organization (negative)", async () => {
    await renderBilling({ ...LOADED, bucket: readOk(invoiceBucket()) });
    expect(
      screen.queryByRole("region", { name: "Buy governed actions" }),
    ).toBeNull();
  });

  it.each(["owner", "admin"] as const)(
    "lets an %s edit auto top-up, counting the governed actions one top-up buys",
    async (role) => {
      await renderBilling(
        {
          ...LOADED,
          bucket: readOk(prepaidBucket({}, { blocks: 3 })),
        },
        { role },
      );
      const topup = section("Auto top-up");
      expect(topup).toHaveAttribute("data-editable", "true");
      expect(topup.querySelector("[data-per-topup]")).toHaveTextContent(
        "= 30,000 governed actions per top-up",
      );
    },
  );

  it("sends an owner of a Free organization to a plan before a token top-up (negative)", async () => {
    await renderBilling(
      {
        ...LOADED,
        rate: readOk(contractRate({ source: "published_tier", tier: "free" })),
      },
      { role: "owner" },
    );
    const balance = section("Token balance");
    expect(balance).toHaveAttribute("data-state", "plan");
    expect(balance).toHaveTextContent("A top-up needs a Build plan or above.");
  });

  it("prints the token balance at face value, with its basis", async () => {
    await renderBilling();
    const balance = section("Token balance");
    expect(balance).toHaveTextContent("Balance$42.00");
    expect(balance).toHaveTextContent(
      "Pays for the tokens Oxagen buys for the in-app agent, at cost with no markup. The balance is the cap.",
    );
  });

  it("keeps every submit off the gold: the header's Change plan is the page's one gold action", async () => {
    await renderBilling();
    expect(gold()).toHaveLength(1);
  });
});

describe("empty", () => {
  const EMPTY: Partial<BillingReads> = {
    plan: readOk({ subscription: null }),
    bucket: readOk(
      prepaidBucket({
        includedGau: 5_000,
        purchasedGau: 0,
        carriedGau: 0,
        usedGau: 0,
        remainingGau: 5_000,
      }),
    ),
    rate: readOk(contractRate({ source: "published_tier", tier: "free" })),
    invoices: invoicePage([]),
  };

  it("says nothing is billable yet, with Back to Fleet, in place of the statement", async () => {
    await renderBilling(EMPTY);
    const state = document.querySelector("[data-state=empty]") as HTMLElement;
    expect(
      within(state).getByRole("heading", { name: "Nothing billable yet" }),
    ).toBeInTheDocument();
    expect(state).toHaveTextContent(
      "You pay per governed action: a call Oxagen decided, delivered and recorded. The free tier has every governance feature on, an included monthly allowance, thirty days of evidence and three seats.",
    );
    expect(
      within(state).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/");
    expect(document.querySelector("[data-tile]")).toBeNull();
    expect(screen.queryByRole("region", { name: "This period" })).toBeNull();
  });

  it("keeps Change plan and the purchase form, so a new organization can still subscribe or buy", async () => {
    await renderBilling(EMPTY);
    expect(gold().map((el) => el.textContent)).toEqual(["Change plan"]);
    expect(section("Buy governed actions")).toBeInTheDocument();
  });

  it("is not the empty state once a governed action is used (negative)", async () => {
    await renderBilling({
      ...EMPTY,
      bucket: readOk(prepaidBucket({ usedGau: 1 })),
    });
    expect(document.querySelector("[data-state=empty]")).toBeNull();
  });
});

describe("error", () => {
  it.each([
    ["plan", { plan: DOWN }],
    ["bucket", { bucket: DOWN }],
  ] as const)(
    "replaces the page with the error state when the %s read fails",
    async (_read, reads) => {
      await renderBilling({ ...LOADED, ...reads });
      const state = document.querySelector("[data-state=error]") as HTMLElement;
      expect(
        within(state).getByRole("heading", {
          name: "Billing could not be loaded",
        }),
      ).toBeInTheDocument();
      expect(state).toHaveTextContent(
        "The control plane answered 502 stripe_unreachable. Nothing was changed. Runs kept recording while this page was down. Frames are written by the collector on each host, not by Oxagen.",
      );
      expect(
        within(state).getByRole("link", { name: "Try again" }),
      ).toHaveAttribute("href", "/acme/billing");
      expect(state).toHaveTextContent(
        /trace not recorded · region not recorded · \d{4}-\d{2}-\d{2}T/,
      );
      expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
      expect(gold().map((el) => el.textContent)).toEqual(["Try again"]);
    },
  );

  it("opens the incident dialog, which says what filing would do and that it is not built yet", async () => {
    await renderBilling({ ...LOADED, bucket: DOWN });
    await userEvent.click(
      screen.getByRole("button", { name: "Open an incident" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Open an incident" });
    expect(dialog).toHaveTextContent(
      "Filing an incident from this page is not in Oxagen yet.",
    );
    expect(dialog).toHaveTextContent("502 stripe_unreachable");
  });
});

describe("access denied", () => {
  it("replaces the page with the denied state, naming the permission, the role and what decided it", async () => {
    await renderBilling(
      {
        plan: DENIED,
        bucket: DENIED,
        rate: DENIED,
        retention: DENIED,
        invoices: DENIED,
        usageCredits: DENIED,
      },
      { role: "member" },
    );
    const state = document.querySelector("[data-state=denied]") as HTMLElement;
    expect(
      within(state).getByRole("heading", { name: "You cannot see billing" }),
    ).toBeInTheDocument();
    expect(state).toHaveTextContent(
      "Your roles on Acme Robotics do not include org.billing (plan and invoices are readable only by a finance role). An organization owner can grant it. The grant is a governed action and lands in the audit record with your name on it.",
    );
    expect(state).toHaveTextContent("Signed in asmember");
    expect(state).toHaveTextContent("Neededorg.billing");
    expect(state).toHaveTextContent(
      "Decided bythe organization's roles · deny wins over every allow",
    );
    expect(
      within(state).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/");
    expect(gold().map((el) => el.textContent)).toEqual(["Request access"]);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("opens the request-access dialog, which says what asking would do and that it is not built yet", async () => {
    await renderBilling({ ...LOADED, invoices: DENIED }, { role: "member" });
    await userEvent.click(
      screen.getByRole("button", { name: "Request access" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Request access" });
    expect(dialog).toHaveTextContent(
      "Asking for a role from this page is not in Oxagen yet. It would send an organization owner a request for org.billing with your reason",
    );
  });

  it("says an access request is waiting for approval", async () => {
    await renderBilling({
      ...LOADED,
      plan: { ok: false, reason: "pending_approval", accessRequestId: "arq_7" },
    });
    const state = document.querySelector("[data-state=pending]");
    expect(state).toHaveTextContent(
      "Access to billing is waiting for approval",
    );
    expect(state).toHaveTextContent(
      "Request arq_7 is waiting on an organization owner.",
    );
  });
});

describe("loading", () => {
  it("draws four tile blocks and a panel of seven rows, with no figure", () => {
    render(
      <IntlProvider>
        <BillingSkeleton />
      </IntlProvider>,
    );
    const skeleton = screen.getByRole("status", { name: "Loading billing" });
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    expect(skeleton.firstElementChild?.children).toHaveLength(4);
    expect(skeleton.querySelectorAll("span.h-7")).toHaveLength(7);
    expect(skeleton.textContent).toBe("");
  });
});
