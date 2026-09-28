// @vitest-environment jsdom
// A ranked chart draws one currency. An amount in another currency has no
// share of the leading bar, so it is left out and counted in the footer
// rather than drawn as a zero-length bar.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Money } from "@/data/contracts/money";
import { IntlProvider } from "@/test/intl";
import { rankInOneCurrency } from "./ranked-spend-chart";
import { ToolChart } from "./tool-chart";

afterEach(cleanup);

const usd = (micros: string): Money => ({ micros, currency: "USD" });
const eur = (micros: string): Money => ({ micros, currency: "EUR" });
const tool = (key: string, cumulative: Money) => ({
  key,
  cumulative,
  perRun: null,
  perCall: null,
});

describe("rankInOneCurrency", () => {
  it("keeps the currency most items carry, largest first, and counts the rest", () => {
    const { ranked, otherCurrency } = rankInOneCurrency([
      { key: "eur-large", value: eur("90000000") },
      { key: "usd-small", value: usd("1000000") },
      { key: "usd-large", value: usd("5000000") },
    ]);
    expect(ranked.map((item) => item.key)).toEqual([
      "usd-large",
      "usd-small",
    ]);
    expect(otherCurrency).toBe(1);
  });

  it("gives a tie to the earlier currency code", () => {
    const { ranked, otherCurrency } = rankInOneCurrency([
      { key: "usd", value: usd("1000000") },
      { key: "eur", value: eur("1000000") },
    ]);
    expect(ranked.map((item) => item.key)).toEqual(["eur"]);
    expect(otherCurrency).toBe(1);
  });

  it("leaves nothing out when every item shares a currency", () => {
    expect(
      rankInOneCurrency([{ key: "a", value: usd("1") }]).otherCurrency,
    ).toBe(0);
    expect(rankInOneCurrency([])).toEqual({ ranked: [], otherCurrency: 0 });
  });
});

describe("ToolChart", () => {
  it("counts a tool billed in another currency in the footer", () => {
    render(
      <IntlProvider>
        <ToolChart
          tools={[
            tool("a", usd("3000000")),
            tool("b", usd("1000000")),
            tool("c", eur("9000000")),
          ]}
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("spend-tool-chart")).toHaveTextContent(
      "The leading 2 of 3. The table holds every tool. One tool is billed in another currency and shown in the table only.",
    );
  });
});
