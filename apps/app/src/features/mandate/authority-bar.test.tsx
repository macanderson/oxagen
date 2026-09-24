// @vitest-environment jsdom
// The Mandate page's remaining-authority bar (`AuthorityBar`), over
// hand-built authorities. The page test in mandate.test.tsx renders the demo
// record, which sits inside its limit, speaks for one money measure and always
// has a per-period figure. These hold the branches that record never reaches,
// each of which is a claim about money a person may act on:
//
// - a limit lowered under authority already drawn: the bar is full, the
//   reservation takes only the room left, and a sentence says the drawn
//   figures sit past the limit (the image's name carries it too);
// - a measure with no per-period limit draws no bar, rather than a bar with no
//   scale;
// - a count measure prints its unit, and no currency;
// - a page with more than one bar names the measure beside each heading.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { MandateAuthority } from "@/data/contracts/mandates";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { callsAuthority, mandateAuthority } from "@/test/mandate-views";
import { AuthorityBar } from "./authority-bar";

afterEach(cleanup);

const usd = (micros: string) =>
  ({ kind: "money", money: { micros, currency: "USD" } }) as const;

function renderBar(
  authority: MandateAuthority,
  {
    named = false,
    openCalls = null,
  }: { named?: boolean; openCalls?: number | null } = {},
) {
  return render(
    <IntlProvider>
      <AuthorityBar authority={authority} named={named} openCalls={openCalls} />
    </IntlProvider>,
  );
}

const part = (name: "settled" | "reserved") =>
  screen
    .getByTestId("authority-bar")
    .querySelector<HTMLElement>(`[data-part="${name}"]`);

describe("AuthorityBar › over the limit", () => {
  // A $500 limit lowered under $600 settled and $100 reserved: the mapper
  // clamps both ratios and sets `overLimit` on the recorded integers.
  const over = mandateAuthority({
    perPeriod: usd("500000000"),
    settled: usd("600000000"),
    reserved: usd("100000000"),
    remaining: usd("0"),
    settledRatio: 1,
    reservedRatio: 0.2,
    overLimit: true,
  });

  it("fills the bar with what settled and leaves the reservation no room past the limit", async () => {
    const { container } = renderBar(over, { openCalls: 1 });
    expect(part("settled")?.style.width).toBe("100%");
    expect(part("reserved")?.style.width).toBe("0%");
    await expectNoAxe(container);
  });

  it("says the drawn figures sit past the limit, in the text and in the image's name", () => {
    renderBar(over, { openCalls: 1 });
    const bar = screen.getByTestId("authority-bar");
    const sentence = bar.querySelector('[data-state="over-limit"]');
    expect(sentence).toHaveTextContent("Drawn authority is past this limit.");
    expect(within(bar).getByRole("img")).toHaveAccessibleName(
      expect.stringContaining(
        "$600.00 settled, $100.00 reserved by this call, $0.00 remaining of $500.00 Drawn authority is past this limit.",
      ),
    );
  });

  it("gives the reservation only the room the settled draws left", () => {
    renderBar(
      mandateAuthority({
        perPeriod: usd("1000000000"),
        settled: usd("800000000"),
        reserved: usd("400000000"),
        remaining: usd("0"),
        settledRatio: 0.8,
        reservedRatio: 0.4,
        overLimit: true,
      }),
    );
    expect(part("settled")?.style.width).toBe("80%");
    // 0.4 reserved, but 0.2 of the bar is all that is left.
    expect(part("reserved")?.style.width).toBe("20%");
    // The legend still states the recorded share, not the clamped width.
    expect(screen.getByText("(40%)")).toBeInTheDocument();
  });

  it("adds no sentence to a measure inside its limit (negative)", () => {
    renderBar(mandateAuthority());
    expect(
      screen
        .getByTestId("authority-bar")
        .querySelector('[data-state="over-limit"]'),
    ).toBeNull();
    expect(screen.getByRole("img")).not.toHaveAccessibleName(
      expect.stringContaining("past this limit"),
    );
  });
});

describe("AuthorityBar › a measure with no per-period limit", () => {
  it("draws no bar, rather than one with no scale (negative)", () => {
    const { container } = renderBar(
      mandateAuthority({
        perPeriod: null,
        remaining: null,
        settledRatio: null,
        reservedRatio: null,
      }),
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("AuthorityBar › a count measure", () => {
  it("prints the limit in its unit, names the measure when asked, and prints no currency", () => {
    renderBar(callsAuthority(), { named: true, openCalls: 3 });
    const bar = screen.getByTestId("authority-bar");
    expect(bar).toHaveAttribute("data-measure", "calls");
    expect(within(bar).getByText("calls", { exact: true })).toBeInTheDocument();
    expect(bar).not.toHaveTextContent("USD");
    expect(bar).not.toHaveTextContent("$");
    expect(
      within(bar).getByText(/reserved by 3 calls in flight/),
    ).toBeInTheDocument();
  });

  it("leaves the measure off the heading when the page draws one bar (negative)", () => {
    renderBar(mandateAuthority(), { named: false });
    const heading = screen.getByText("Remaining authority");
    expect(heading).toHaveTextContent(/^Remaining authority$/);
  });
});

describe("AuthorityBar › who holds the reservation", () => {
  it("claims no count when no open call was found on the page read", () => {
    renderBar(mandateAuthority(), { openCalls: 0 });
    expect(
      screen.getByText(/^reserved by calls in flight/),
    ).toBeInTheDocument();
  });
});
