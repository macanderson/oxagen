// @vitest-environment jsdom
// The mandate bar in each state the ledger produces: a mandate with a
// reservation held, one with none, one whose limit is a count, and one whose
// measure has no per-period limit and so has no bar at all. Every state is
// checked for accessibility (INV-26).
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { MandateAuthority } from "@/data/contracts/mandates";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { MandateBar } from "./mandate-bar";

afterEach(cleanup);

const money = (micros: string) =>
  ({ kind: "money", money: { micros, currency: "USD" } }) as const;

function authority(
  overrides: Partial<MandateAuthority> = {},
): MandateAuthority {
  return {
    measure: "amount",
    period: "monthly",
    periodKey: "2026-09",
    perCall: money("250000000"),
    perPeriod: money("2000000000"),
    settled: money("1204180000"),
    reserved: money("180000000"),
    remaining: money("615820000"),
    settledRatio: 0.60209,
    reservedRatio: 0.09,
    ...overrides,
  };
}

function draw(element: ReactElement) {
  return render(<IntlProvider>{element}</IntlProvider>);
}

const bar = () => screen.getByTestId("mandate-bar");
const meter = () => screen.getByRole("img");

describe("MandateBar", () => {
  it("names the period and the limit the authority is counted against", async () => {
    const { container } = draw(<MandateBar authority={authority()} />);
    expect(bar()).toHaveAttribute("data-measure", "amount");
    expect(bar()).toHaveTextContent("Remaining authority · monthly · 2026-09");
    expect(bar()).toHaveTextContent("of $2,000.00");
    await expectNoAxe(container);
  });

  it("draws settled and the reservation, and reads them out in the label", async () => {
    const { container } = draw(<MandateBar authority={authority()} />);
    expect(meter()).toHaveAccessibleName(
      "$1,204.18 settled, $180.00 reserved by calls in flight, $615.82 remaining of $2,000.00",
    );
    const parts = [...bar().querySelectorAll("i")].map((part) => [
      part.dataset.part,
      part.style.width,
    ]);
    expect(parts).toEqual([
      ["settled", "60.2%"],
      ["reserved", "9%"],
    ]);
    await expectNoAxe(container);
  });

  it("shows a reservation only while one is held (negative)", async () => {
    const { container } = draw(
      <MandateBar
        authority={authority({ reserved: money("0"), reservedRatio: 0 })}
      />,
    );
    expect(bar()).not.toHaveTextContent("reserved by calls in flight");
    expect([...bar().querySelectorAll("i")].map((p) => p.dataset.part)).toEqual(
      ["settled"],
    );
    expect(meter()).toHaveAccessibleName(
      "$1,204.18 settled, $615.82 remaining of $2,000.00",
    );
    await expectNoAxe(container);
  });

  it("prints a count measure in its own unit", async () => {
    const count = (n: number) =>
      ({ kind: "count", count: n, unit: "calls" }) as const;
    const { container } = draw(
      <MandateBar
        authority={authority({
          measure: "calls",
          period: "daily",
          periodKey: "2026-09-16",
          perCall: null,
          perPeriod: count(50),
          settled: count(11),
          reserved: count(1),
          remaining: count(38),
          settledRatio: 0.22,
          reservedRatio: 0.02,
        })}
      />,
    );
    expect(bar()).toHaveTextContent("of 50 calls");
    expect(bar()).toHaveTextContent("11 calls");
    expect(meter()).toHaveAccessibleName(
      "11 calls settled, 1 calls reserved by calls in flight, 38 calls remaining of 50 calls",
    );
    await expectNoAxe(container);
  });

  it("draws nothing for a measure with no per-period limit (negative)", () => {
    draw(
      <MandateBar
        authority={authority({
          perPeriod: null,
          remaining: null,
          settledRatio: null,
          reservedRatio: null,
        })}
      />,
    );
    expect(screen.queryByTestId("mandate-bar")).toBeNull();
  });
});
