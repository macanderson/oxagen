/**
 * `oxagen billing statement` — flag checks, the summary, and the CSV export
 * paged through the cursor into one file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureWriter } from "../lib/capture-writer.js";
import {
  billingStatement,
  type BillingStatementDeps,
} from "./billing-statement.js";

const SUMMARY = {
  reference: "ST-0192F3A4-20260901-20260930",
  provisional: false,
  org: { name: "Acme", slug: "acme" },
  period: {
    label: "September 2026",
    start: "2026-09-01T00:00:00.000Z",
    end: "2026-10-01T00:00:00.000Z",
  },
  terms: {
    currency: "usd",
    ratePerGauMicros: "5000",
    source: "published_tier",
  },
  governedActions: {
    totalUnits: 12,
    totalActions: 10,
    bySource: [{ source: "kernel", units: 12, actions: 10 }],
  },
  invoiceTotals: [
    {
      currency: "usd",
      invoices: 2,
      dueMicros: "123456789",
      paidMicros: "100000000",
    },
  ],
  usageCredits: { openingCredits: "1000", closingCredits: "900" },
  reconciliation: [{ id: "units_by_day", holds: true }],
};

function deps(post: BillingStatementDeps["post"]) {
  const files = new Map<string, string>();
  const d: BillingStatementDeps = {
    post,
    writeFile: async (p, c) => {
      files.set(p, c);
    },
    appendFile: async (p, c) => {
      files.set(p, (files.get(p) ?? "") + c);
    },
    today: () => "2026-09-23",
  };
  return { d, files };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("oxagen billing statement", () => {
  it("refuses an unknown period, format or a custom range without both ends, before any call", async () => {
    const post = vi.fn();
    const { d } = deps(post as unknown as BillingStatementDeps["post"]);
    for (const opts of [
      { period: "fortnight" },
      { period: "month", format: "pdf" },
      { period: "custom", from: "2026-09-01T00:00:00Z" },
      { period: "month", from: "2026-09-01T00:00:00Z" },
      { period: "month", top: "0" },
      { period: "month", format: "csv", pageSize: "50001" },
    ]) {
      const w = captureWriter();
      process.exitCode = undefined;
      await billingStatement(opts, w.writer, d);
      expect(process.exitCode, JSON.stringify(opts)).toBe(2);
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("reads the statement for today's month when no anchor is given, and prints the totals", async () => {
    const post = vi.fn(async () => SUMMARY);
    const { d } = deps(post as unknown as BillingStatementDeps["post"]);
    const w = captureWriter();
    await billingStatement({ period: "month" }, w.writer, d);
    expect(post).toHaveBeenCalledWith("billing/statement", {
      period: "month",
      anchor: "2026-09-23",
    });
    const text = w.output();
    expect(text).toContain(
      "ST-0192F3A4-20260901-20260930  Acme (acme)  September 2026",
    );
    expect(text).toContain("Invoices: 2, due 123.45 USD, paid 100.00 USD");
    expect(text).toContain("Reconciliation: every check holds.");
  });

  it("emits the contract payload on one line with --json", async () => {
    const post = vi.fn(async () => SUMMARY);
    const { d } = deps(post as unknown as BillingStatementDeps["post"]);
    const w = captureWriter();
    await billingStatement(
      { period: "quarter", anchor: "2026-07-01", top: "5", json: true },
      w.writer,
      d,
    );
    expect(post).toHaveBeenCalledWith("billing/statement", {
      period: "quarter",
      anchor: "2026-07-01",
      top: 5,
    });
    expect(JSON.parse(w.output().split("\n")[0] ?? "")).toEqual(SUMMARY);
  });

  it("pages the CSV through the cursor into one file", async () => {
    const pages = [
      {
        reference: "R",
        filename: "R.csv",
        content: "header\r\nrow1\r\n",
        lines: 1,
        nextCursor: "c1",
      },
      {
        reference: "R",
        filename: "R.csv",
        content: "row2\r\n",
        lines: 1,
        nextCursor: "c2",
      },
      {
        reference: "R",
        filename: "R.csv",
        content: "row3\r\n",
        lines: 1,
        nextCursor: null,
      },
    ];
    const post = vi.fn(async () => pages.shift());
    const { d, files } = deps(post as unknown as BillingStatementDeps["post"]);
    const w = captureWriter();
    await billingStatement(
      {
        period: "custom",
        from: "2026-09-01T00:00:00Z",
        to: "2026-09-10T00:00:00Z",
        format: "csv",
        out: "s.csv",
        pageSize: "1",
      },
      w.writer,
      d,
    );
    expect(files.get("s.csv")).toBe("header\r\nrow1\r\nrow2\r\nrow3\r\n");
    expect(post).toHaveBeenNthCalledWith(1, "billing/statement/export", {
      period: "custom",
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-10T00:00:00Z",
      format: "csv",
      limit: 1,
    });
    expect(post).toHaveBeenNthCalledWith(
      3,
      "billing/statement/export",
      expect.objectContaining({ cursor: "c2" }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("says how much of the file was written when a later page fails", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        reference: "R",
        filename: "R.csv",
        content: "h\r\nr1\r\n",
        lines: 1,
        nextCursor: "c1",
      })
      .mockRejectedValueOnce(new Error("503 Service Unavailable"));
    const { d, files } = deps(post as unknown as BillingStatementDeps["post"]);
    const w = captureWriter();
    await billingStatement(
      { period: "year", anchor: "2026-01-01", format: "csv", out: "y.csv" },
      w.writer,
      d,
    );
    expect(process.exitCode).toBe(1);
    expect(files.get("y.csv")).toBe("h\r\nr1\r\n");
    expect(w.output()).toContain("y.csv holds the first 1 rows only.");
  });

  it("writes the HTML document to stdout when no --out is given", async () => {
    const post = vi.fn(async () => ({
      reference: "R",
      filename: "R.html",
      content: "<!doctype html>\n",
      lines: 0,
      nextCursor: null,
    }));
    const { d } = deps(post as unknown as BillingStatementDeps["post"]);
    const w = captureWriter();
    await billingStatement(
      { period: "week", anchor: "2026-09-14", format: "html" },
      w.writer,
      d,
    );
    expect(w.output().split("\n")).toContain("<!doctype html>");
  });
});
