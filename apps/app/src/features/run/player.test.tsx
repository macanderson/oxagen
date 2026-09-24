// @vitest-environment jsdom
// The frame player's cost line ("$X of $Y by here", spec pages/run.md
// Governed actions), over hand-built frame pages. The page test in
// run.test.tsx proves the line on frames that are all priced in dollars on one
// basis. These hold the other cases, each of which decides whether a money
// figure is printed at all and what it claims about who observed it:
//
// - no frame up to the open one is priced: the line says so, and prints no
//   $0.00;
// - frames priced in two currencies have no one total, so none is printed;
// - a run with no cost of its own prints the sum "by here" with no "of";
// - the sum carries the basis of the first priced frame. A page that mixes
//   bases still prints only that first basis: this pins that behaviour as it
//   stands rather than endorsing it.
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunFrame } from "@/data/contracts/run";
import { IntlProvider } from "@/test/intl";
import { FramePlayer } from "./player";
import { NOW, runFrame } from "./run.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
// jsdom has no layout, so it has no scrollIntoView; the frame list calls it.
Element.prototype.scrollIntoView = vi.fn();

afterEach(cleanup);

const PLACE = {
  org: "acme",
  ws: "core-platform",
  runId: "tse_7k2m9q",
  frames: null,
};

type Basis = "gateway_observed" | "client_attested" | null;
const cost = (
  micros: string,
  currency = "USD",
  basis: Basis = "gateway_observed",
) => ({
  micros,
  currency,
  basis,
});

function renderPlayer(
  frames: RunFrame[],
  runCost: { micros: string; currency: string } | null = {
    micros: "4131265",
    currency: "USD",
  },
) {
  return render(
    <IntlProvider>
      <FramePlayer
        frames={frames}
        total={frames.length}
        status="sealed"
        runCost={runCost}
        openSeq={null}
        place={PLACE}
        at={NOW}
      />
    </IntlProvider>,
  );
}

const line = () => screen.getByTestId("player-cost");

describe("FramePlayer › the cost by here", () => {
  it("sums the priced frames up to the open one against the run's cost, on their basis", () => {
    renderPlayer([
      runFrame({ seq: "1", cost: cost("1000000") }),
      runFrame({ seq: "2", cost: null }),
      runFrame({ seq: "3", cost: cost("500000") }),
    ]);
    // The player opens on the last frame of the page.
    expect(line()).toHaveTextContent("$1.50 of $4.13 by here");
    expect(screen.getByTestId("player-cost-basis")).toHaveTextContent(
      "gateway_observed",
    );
  });

  it("says no frame up to here carries a price, and prints no $0.00 (negative)", () => {
    renderPlayer([
      runFrame({ seq: "1", cost: null }),
      runFrame({ seq: "2", cost: null }),
    ]);
    expect(line()).toHaveTextContent("No frame up to here carries a price.");
    expect(line()).not.toHaveTextContent("$");
    expect(screen.queryByTestId("player-cost-basis")).toBeNull();
  });

  it("prints no total for frames priced in two currencies (negative)", () => {
    renderPlayer([
      runFrame({ seq: "1", cost: cost("1000000", "USD") }),
      runFrame({ seq: "2", cost: cost("1000000", "EUR") }),
    ]);
    expect(line()).toHaveTextContent("No frame up to here carries a price.");
    expect(line()).not.toHaveTextContent("$");
    expect(line()).not.toHaveTextContent("€");
  });

  it("prints the sum by here with no of when the run carries no cost of its own", () => {
    renderPlayer([runFrame({ seq: "1", cost: cost("250000") })], null);
    expect(line()).toHaveTextContent("$0.25 by here");
    expect(line()).not.toHaveTextContent(" of ");
  });

  it("says the basis is not recorded when the first priced frame carries none", () => {
    renderPlayer([runFrame({ seq: "1", cost: cost("250000", "USD", null) })]);
    expect(screen.getByTestId("player-cost-basis")).toHaveTextContent(
      "basis not recorded",
    );
  });

  it("prints the first priced frame's basis for a page that mixes bases (characterization)", () => {
    renderPlayer([
      runFrame({ seq: "1", cost: cost("100000", "USD", "client_attested") }),
      runFrame({ seq: "2", cost: cost("900000", "USD", "gateway_observed") }),
    ]);
    expect(line()).toHaveTextContent("$1.00 of $4.13 by here");
    // Nine tenths of this sum was gateway observed, yet the caption names
    // only the first frame's basis. Recorded as it stands, not endorsed.
    expect(screen.getByTestId("player-cost-basis")).toHaveTextContent(
      /^client_attested$/,
    );
  });
});
