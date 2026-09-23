// @vitest-environment jsdom
// Spend › By cost center (ADR-142): one row per label and one for the spend no
// cost center claims, each spend beside its basis and its share of the month,
// and a share that reads not recorded when either side was not priced.
import { cleanup, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";
import {
  type SpendFigure,
  type SpendReport,
  UNASSIGNED_COST_CENTER_KEY,
} from "@/data/contracts/spend";
import { expectNoAxe } from "@/test/expect-no-axe";
import messages from "../../../messages/spend.json";
import { CostCenterTable, shareOf } from "./cost-centers";

afterEach(() => {
  cleanup();
});

/** The table row a cell's text sits in. */
function rowOf(element: HTMLElement): HTMLElement {
  const row = element.closest("tr");
  if (row === null) throw new Error("the text is not in a table row");
  return row;
}

const figure = (micros: string | null, runs = 1): SpendFigure => ({
  cost:
    micros === null
      ? null
      : { micros, currency: "USD", basis: "gateway_observed" },
  calls: runs * 3,
  runs,
  proven: null,
  accepted: null,
  productiveRatio: null,
});

const row = (key: string, micros: string | null, runs = 1) => ({
  ...figure(micros, runs),
  key,
  provider: null,
  tokens: {
    input_uncached: 120,
    cache_read: 80,
    cache_write_5m: 10,
    cache_write_1h: 5,
    output: 40,
    reasoning: 20,
  },
  operator: null,
});

const report: SpendReport = {
  period: { from: "2026-09-01", to: "2026-09-22" },
  total: figure("10000000", 4),
  rows: [
    row("ENG-1001", "6000000", 2),
    row("MKT-2002", "3000000"),
    row(UNASSIGNED_COST_CENTER_KEY, "1000000"),
  ],
};

async function renderTable(value: SpendReport = report) {
  const view = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CostCenterTable report={value} />
    </NextIntlClientProvider>,
  );
  await expectNoAxe(view.container);
  return view;
}

describe("shareOf", () => {
  it("divides the row's spend by the total's", () => {
    expect(shareOf(figure("2500000"), figure("10000000"))).toBe(0.25);
  });

  it("has no share when either side was not priced", () => {
    expect(shareOf(figure(null), figure("10000000"))).toBeNull();
    expect(shareOf(figure("1"), figure(null))).toBeNull();
    expect(shareOf(figure("1"), figure("0"))).toBeNull();
  });
});

describe("CostCenterTable", () => {
  it("shows the unassigned share as its own row", async () => {
    await renderTable();
    const none = rowOf(screen.getByText("No cost center"));
    expect(none.getAttribute("data-unassigned")).toBe("true");
    expect(within(none).getByText("10%")).toBeDefined();
  });

  it("prints every spend beside its basis and explains the share", async () => {
    await renderTable();
    const eng = rowOf(screen.getByText("ENG-1001"));
    expect(within(eng).getByText("gateway_observed")).toBeDefined();
    expect(within(eng).getByText("60%")).toBeDefined();
    expect(
      screen.getByText(
        "Share is the row's spend divided by the month's spend in the strip above, both on the basis beside each figure.",
      ),
    ).toBeDefined();
  });

  it("reads an unpriced row as not recorded rather than zero", async () => {
    await renderTable({
      ...report,
      rows: [row("ENG-1001", null)],
    });
    const eng = rowOf(screen.getByText("ENG-1001"));
    expect(within(eng).getAllByText("not recorded")).toHaveLength(2);
  });
});
