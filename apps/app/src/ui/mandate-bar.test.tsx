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
    overLimit: false,
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
    const count = (n: string) =>
      ({ kind: "count", count: n, unit: "calls" }) as const;
    const { container } = draw(
      <MandateBar
        authority={authority({
          measure: "calls",
          period: "daily",
          periodKey: "2026-09-16",
          perCall: null,
          perPeriod: count("50"),
          settled: count("11"),
          reserved: count("1"),
          remaining: count("38"),
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

  // `update_mandate_limits` may lower a limit under authority already drawn,
  // so the two ratios can total more than one. Clamping each on its own and
  // letting flex resolve the overflow rescaled both, drawing a half-used bar
  // over a limit that is fully settled and overcommitted.
  it("draws an over-limit period as full, not as a balanced bar (negative)", async () => {
    const { container } = draw(
      <MandateBar
        authority={authority({
          perPeriod: money("500000000"),
          settled: money("500000000"),
          reserved: money("500000000"),
          remaining: null,
          settledRatio: 1,
          reservedRatio: 1,
          overLimit: true,
        })}
      />,
    );
    const parts = [...bar().querySelectorAll("i")].map((part) => [
      part.dataset.part,
      part.style.width,
    ]);
    expect(parts).toEqual([
      ["settled", "100%"],
      ["reserved", "0%"],
    ]);
    for (const part of bar().querySelectorAll("i")) {
      expect(part.className).toContain("shrink-0");
    }
    expect(bar()).toHaveAttribute("data-over", "true");
    expect(screen.getByText(/fully settled and overcommitted/)).toHaveAttribute(
      "data-state",
      "over-limit",
    );
    expect(meter()).toHaveAccessibleName(
      expect.stringContaining("overcommitted"),
    );
    await expectNoAxe(container);
  });

  // The ratios cannot answer this. `ratioOfIntegers` clamps each to 1, so 600
  // settled with nothing reserved against a limit lowered to 500 arrives as
  // 1 + 0, which is not greater than 1 — a sum of ratios misses a
  // single-component excess entirely. The flag is taken on the integers.
  it("marks an excess carried by settlement alone, which no ratio sum can see", () => {
    draw(
      <MandateBar
        authority={authority({
          perPeriod: money("500000000"),
          settled: money("600000000"),
          reserved: money("0"),
          remaining: null,
          settledRatio: 1,
          reservedRatio: 0,
          overLimit: true,
        })}
      />,
    );
    expect(bar()).toHaveAttribute("data-over", "true");
    expect(screen.getByText(/fully settled and overcommitted/)).toHaveAttribute(
      "data-state",
      "over-limit",
    );
  });

  it("says nothing when the ledger is exactly at the limit (negative)", () => {
    draw(
      <MandateBar
        authority={authority({
          perPeriod: money("500000000"),
          settled: money("500000000"),
          reserved: money("0"),
          remaining: money("0"),
          settledRatio: 1,
          reservedRatio: 0,
          overLimit: false,
        })}
      />,
    );
    expect(bar()).not.toHaveAttribute("data-over");
    expect(screen.queryByText(/overcommitted/)).toBeNull();
  });

  it("leaves a period inside its limit unmarked and unshrunk", () => {
    draw(<MandateBar authority={authority()} />);
    expect(bar()).not.toHaveAttribute("data-over");
    expect(screen.queryByText(/overcommitted/)).toBeNull();
  });

  it("gives the reservation only the room settlement leaves", () => {
    draw(
      <MandateBar
        authority={authority({ settledRatio: 0.8, reservedRatio: 0.5 })}
      />,
    );
    const parts = [...bar().querySelectorAll("i")].map((part) => [
      part.dataset.part,
      part.style.width,
    ]);
    expect(parts).toEqual([
      ["settled", "80%"],
      ["reserved", "20%"],
    ]);
  });
});
