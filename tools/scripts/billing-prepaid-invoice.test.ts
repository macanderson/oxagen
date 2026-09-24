/**
 * Unit tests for billing-prepaid-invoice: the flags, the summary and its
 * assistant-cap warning, the dry run, the resume hint, and the input
 * `create_prepaid_invoice` receives. The invoke path itself
 * (lib/platform-operator-run.ts) and the order sequence
 * (packages/billing/src/prepaid-orders.ts) have their own tests.
 */
import { describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import {
  assistantCapLines,
  parsePrepaidInvoiceFlags,
  runPrepaidInvoice,
  type PrepaidInvoiceRunDeps,
} from "./billing-prepaid-invoice";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const ORDER = "0192d4a8-7c1e-7a00-8000-0000000000d1";

/** The lead's worked example. */
const argv = [
  "--org",
  "acme",
  "--agreement",
  "MSA-2026-014",
  "--po",
  "PO-7781",
  "--licence-usd",
  "120000",
  "--licence-from",
  "2026-10-01",
  "--licence-to",
  "2027-10-01",
  "--credits-usd",
  "5000",
  "--gau",
  "2000000",
  "--days-until-due",
  "30",
];

function deps(over: Partial<PrepaidInvoiceRunDeps> = {}) {
  const lines: string[] = [];
  const order: string[] = [];
  const invoke = vi.fn(
    async (_name: string, input: unknown, _ctx: CapabilityContext) => {
      order.push("invoke");
      const i = input as Record<string, unknown>;
      return {
        orderId: i.orderId,
        orgId: ORG,
        resumed: false,
        status: "open",
        agreementRef: "MSA-2026-014",
        poNumber: "PO-7781",
        currency: "usd",
        lines: [],
        totalMicros: "131000000000",
        stripeInvoiceId: "in_pre_001",
        invoiceNumber: "OXA-0042",
        hostedInvoiceUrl: "https://invoice.stripe.com/i/pre",
        invoicePdfUrl: null,
        grant: null,
      };
    },
  );
  const d: PrepaidInvoiceRunDeps = {
    resolveOrg: async () => ({ id: ORG, name: "Acme" }),
    readDefaults: async () => ({
      currency: "usd",
      agreementRef: "MSA-2026-014",
      ratePerGauMicros: 3_000n,
    }),
    readAssistantSpendCap: async () => 2_000,
    newOrderId: () => ORDER,
    invoke,
    setSecurityEventEmitter: vi.fn(),
    recordSecurityEvent: vi.fn(async () => {}),
    requestId: "req-1",
    log: (l) => {
      lines.push(l);
      order.push("log");
    },
    ...over,
  };
  return { d, invoke, lines, order };
}

describe("parsePrepaidInvoiceFlags", () => {
  it("reads the worked example exactly", () => {
    expect(parsePrepaidInvoiceFlags(argv)).toEqual({
      orgSlug: "acme",
      orderId: null,
      dryRun: false,
      request: {
        agreementRef: "MSA-2026-014",
        poNumber: "PO-7781",
        currency: "usd",
        licence: {
          amountCents: 12_000_000,
          periodStart: new Date("2026-10-01T00:00:00.000Z"),
          periodEnd: new Date("2027-10-01T00:00:00.000Z"),
        },
        gau: { quantity: 2_000_000 },
        creditsCents: 500_000,
        daysUntilDue: 30,
        grantOn: "paid",
      },
    });
  });

  it("reads the cap in dollars or none, the rate override, grant-on, the memo and a resume id", () => {
    const f = parsePrepaidInvoiceFlags([
      ...argv,
      "--assistant-cap-usd",
      "none",
      "--gau-rate-per-1000-usd",
      "2.50",
      "--grant-on",
      "issue",
      "--memo",
      "Year one.",
      "--order-id",
      ORDER,
      "--dry-run",
    ]);
    expect(f).toMatchObject({ orderId: ORDER, dryRun: true });
    expect(f.request).toMatchObject({
      assistantSpendCapCents: null,
      gau: { quantity: 2_000_000, ratePerGauMicros: 2_500n },
      grantOn: "issue",
      memo: "Year one.",
    });
    expect(
      parsePrepaidInvoiceFlags([...argv, "--assistant-cap-usd", "6000"]).request
        .assistantSpendCapCents,
    ).toBe(600_000);
  });

  it("leaves the cap out when the flag is absent, so the cap stays as it is", () => {
    expect(parsePrepaidInvoiceFlags(argv).request).not.toHaveProperty(
      "assistantSpendCapCents",
    );
  });

  it("defaults the payment term to 30 days", () => {
    expect(
      parsePrepaidInvoiceFlags(["--org", "acme", "--credits-usd", "10"]).request
        .daysUntilDue,
    ).toBe(30);
  });

  it.each([
    [["--licence-usd", "10"], /given together/],
    [["--gau-rate-per-1000-usd", "3"], /needs --gau/],
    [["--grant-on", "later"], /"paid" or "issue"/],
    [["--order-id", "order-1"], /uuid an earlier run printed/],
    [["--credits-usd", "10.001"], /--credits-usd/],
  ])("refuses case %#", (extra, message) => {
    expect(() => parsePrepaidInvoiceFlags(["--org", "acme", ...extra])).toThrow(
      message,
    );
  });

  it("requires --org", () => {
    expect(() => parsePrepaidInvoiceFlags(["--credits-usd", "10"])).toThrow(
      /--org is required/,
    );
  });
});

describe("assistantCapLines", () => {
  it("warns when the credits exceed a cap the order leaves alone", () => {
    const lines = assistantCapLines(500_000, 2_000, undefined);
    expect(lines[0]).toMatch(/\$20\.00 a month now/);
    expect(lines.at(-1)).toMatch(
      /Warning.*\$5,000\.00 of assistant credits.*\$20\.00 a month.*--assistant-cap-usd/,
    );
  });

  it("does not warn when the cap covers the credits, or there is no cap", () => {
    expect(assistantCapLines(1_000, 2_000, undefined).join("\n")).not.toMatch(
      /Warning/,
    );
    expect(assistantCapLines(500_000, null, undefined).join("\n")).not.toMatch(
      /Warning/,
    );
  });

  it("says what the order will set instead of warning", () => {
    const lines = assistantCapLines(500_000, 2_000, 600_000).join("\n");
    expect(lines).toMatch(
      /set to \$6,000\.00 a month when the credits are granted/,
    );
    expect(lines).not.toMatch(/Warning/);
    expect(assistantCapLines(500_000, 2_000, null).join("\n")).toMatch(
      /set to no cap/,
    );
  });
});

describe("runPrepaidInvoice", () => {
  it("prints the lines, the total and the cap warning, then the resume hint, then invokes", async () => {
    const { d, invoke, lines, order } = deps();

    const issued = await runPrepaidInvoice(parsePrepaidInvoiceFlags(argv), d);

    const text = lines.join("\n");
    expect(text).toMatch(
      /Line {9}: Oxagen platform licence \(agreement MSA-2026-014\): 1 Oct 2026 to 30 Sep 2027 {2}\$120,000\.00/,
    );
    expect(text).toMatch(
      /Governed action units, prepaid: 2,000,000 GAU at \$3\.00 per 1,000 {2}\$6,000\.00/,
    );
    expect(text).toMatch(
      /Usage credits for the in-app assistant, prepaid: \$5,000\.00 \(500,000 credits\) {2}\$5,000\.00/,
    );
    expect(text).toMatch(/Total {8}: \$131,000\.00, due 30 days/);
    expect(text).toMatch(/Warning/);
    expect(text).toMatch(new RegExp(`--order-id ${ORDER} to resume`));
    // The hint is printed before the invoke, so a crash mid-call still shows it.
    expect(order.lastIndexOf("log", order.indexOf("invoke"))).toBeGreaterThan(
      -1,
    );
    expect(lines.findIndex((l) => l.includes("to resume"))).toBeLessThan(
      lines.findIndex((l) => l.includes("Issued")),
    );
    expect(issued?.invoiceNumber).toBe("OXA-0042");

    expect(invoke.mock.calls[0]![0]).toBe("create_prepaid_invoice");
    expect(invoke.mock.calls[0]![1]).toEqual({
      orgId: ORG,
      orderId: ORDER,
      agreementRef: "MSA-2026-014",
      poNumber: "PO-7781",
      currency: "usd",
      licence: {
        amountCents: 12_000_000,
        periodStart: "2026-10-01T00:00:00.000Z",
        periodEnd: "2027-10-01T00:00:00.000Z",
      },
      gau: { quantity: 2_000_000 },
      creditsCents: 500_000,
      daysUntilDue: 30,
      grantOn: "paid",
    });
  });

  it("resumes the order the operator names", async () => {
    const { d, invoke } = deps({ newOrderId: () => "should-not-be-used" });
    const other = "0192d4a8-7c1e-7a00-8000-0000000000d9";
    await runPrepaidInvoice(
      parsePrepaidInvoiceFlags([...argv, "--order-id", other]),
      d,
    );
    expect((invoke.mock.calls[0]![1] as { orderId: string }).orderId).toBe(
      other,
    );
  });

  it("passes the cap on when the operator gives one", async () => {
    const { d, invoke } = deps();
    await runPrepaidInvoice(
      parsePrepaidInvoiceFlags([...argv, "--assistant-cap-usd", "none"]),
      d,
    );
    expect(invoke.mock.calls[0]![1]).toMatchObject({
      assistantSpendCapCents: null,
    });
  });

  it("validates and prints on a dry run, and neither writes nor calls Stripe", async () => {
    const { d, invoke, lines } = deps();
    expect(
      await runPrepaidInvoice(
        parsePrepaidInvoiceFlags([...argv, "--dry-run"]),
        d,
      ),
    ).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(d.setSecurityEventEmitter).not.toHaveBeenCalled();
    expect(lines.at(-1)).toMatch(/Dry run: nothing written, Stripe not called/);
  });

  it("refuses units without a contracted rate, on a dry run too", async () => {
    const { d, invoke } = deps({
      readDefaults: async () => ({
        currency: "usd",
        agreementRef: null,
        ratePerGauMicros: null,
      }),
    });
    await expect(
      runPrepaidInvoice(parsePrepaidInvoiceFlags([...argv, "--dry-run"]), d),
    ).rejects.toMatchObject({ reason: "gau_rate_required" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses an order the table would refuse before invoking", async () => {
    const { d, invoke } = deps();
    const f = parsePrepaidInvoiceFlags([
      "--org",
      "acme",
      "--gau",
      "3",
      "--gau-rate-per-1000-usd",
      "3.333",
    ]);
    await expect(runPrepaidInvoice(f, d)).rejects.toMatchObject({
      reason: "gau_not_whole_cents",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses an org whose terms are not in USD", async () => {
    const { d } = deps({
      readDefaults: async () => ({
        currency: "eur",
        agreementRef: "X",
        ratePerGauMicros: 3_000n,
      }),
    });
    await expect(
      runPrepaidInvoice(parsePrepaidInvoiceFlags(argv), d),
    ).rejects.toThrow(/terms are in eur; this script invoices in USD/);
  });
});
