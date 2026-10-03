// @vitest-environment jsdom
// The Wasted spend tab. When little or nothing is recorded every tile says
// "not recorded" rather than printing a zero it was not given, a period with
// no waste says so, and a cause recorded against an unknown total draws no
// share bar it cannot compute. A period whose calls findings claim draws each
// claimed cause list_waste returns and drops the design row it records
// (#5294). A period with no claimed call says how many open findings claim
// calls outside it, and links to them.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import type { SpendReport, SpendWaste } from "@/data/contracts/spend";
import { IntlProvider } from "@/test/intl";
import { WasteSection } from "./waste";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

const AT = { org: "acme", ws: "core-platform" };

const MONTH: SpendReport = {
  period: { from: "2026-10-01", to: "2026-10-02" },
  total: {
    cost: null,
    calls: 0,
    runs: 88,
    proven: null,
    accepted: null,
    productiveRatio: null,
  },
  rows: [],
};

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

const NOTHING: SpendWaste = {
  wasted: null,
  share: null,
  runsWithWaste: 0,
  largestCause: null,
  findingsOutsidePeriod: 0,
  causes: [],
};

const usd = (micros: string, basis: "client_attested" | "mixed") => ({
  micros,
  currency: "USD",
  basis,
});

/** A period whose calls three findings claim, beside a cache write no call read. */
const CLAIMED: SpendWaste = {
  wasted: usd("31220000", "mixed"),
  share: 0.0074,
  runsWithWaste: 3,
  largestCause: "repeated_calls",
  findingsOutsidePeriod: 2,
  causes: [
    {
      cause: "repeated_calls",
      wasted: usd("30220000", "client_attested"),
      runs: 2,
      provingRuns: [
        { runId: "tse_01k5rn9aaa", name: "Repair the login redirect" },
        { runId: "tse_01k5rn9bbb", name: null },
      ],
    },
    {
      cause: "retry_loops",
      wasted: usd("590000", "client_attested"),
      runs: 1,
      provingRuns: [{ runId: "tse_01k5rn9ccc", name: null }],
    },
    {
      cause: "cache_write_never_read",
      wasted: usd("410000", "client_attested"),
      runs: 1,
      provingRuns: [{ runId: "arun_01k5rn8f3j", name: null }],
    },
  ],
};

function waste(value: SpendWaste) {
  render(
    <IntlProvider>
      <WasteSection waste={value} month={MONTH} at={AT} />
    </IntlProvider>,
  );
}

function causes(): HTMLElement {
  const panel = screen
    .getByRole("heading", { name: "By cause" })
    .closest("section");
  if (!(panel instanceof HTMLElement)) throw new Error("no By cause panel");
  return panel;
}

const designRows = () =>
  Array.from(causes().querySelectorAll('li[data-recorded="false"]')).map(
    (li) => li.getAttribute("data-cause"),
  );

describe("Wasted spend", () => {
  it("says not recorded for the amount and share, no cause, and no run with waste", () => {
    waste(NOTHING);
    expect(
      document.querySelectorAll('[data-recorded="false"]').length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("No waste found")).toBeTruthy();
    expect(
      screen.getByText("No run in this period shows waste in its frames."),
    ).toBeTruthy();
    expect(document.body).not.toHaveTextContent("$0");
    // Every cause the design meters reads not recorded, retry loops and
    // halted early among them, since no finding claims a call in the period.
    expect(designRows()).toEqual([
      "cacheMisses",
      "correctivePrompts",
      "retryLoops",
      "contextBloat",
      "idleWhileParked",
      "haltedEarly",
    ]);
    expect(screen.queryByTestId("waste-outside")).toBeNull();
  });

  it("draws a recorded cause with an empty share bar when the total wasted is not recorded, and no largest cause it cannot find", () => {
    waste({
      ...NOTHING,
      share: 0.1,
      runsWithWaste: 1,
      largestCause: "cache_write_never_read",
      causes: [
        {
          cause: "cache_write_never_read",
          wasted: {
            micros: "1000000",
            currency: "USD",
            basis: "gateway_observed",
          },
          runs: 1,
          provingRuns: [{ runId: "arun_01k5rn8f3j", name: null }],
        },
      ],
    });
    const cause = document.querySelector(
      'li[data-cause="cache_write_never_read"]',
    );
    expect(
      cause?.querySelector('[style*="width"]')?.getAttribute("style"),
    ).toContain("width: 0%");
    expect(screen.getByText("arun_01k5rn8f3j", { exact: false })).toBeTruthy();
    expect(screen.getByText("Untitled session")).toBeTruthy();

    cleanup();
    waste({ ...NOTHING, largestCause: "cache_write_never_read" });
    expect(screen.getByText("No waste found")).toBeTruthy();
  });
});

describe("Wasted spend with claimed calls (#5294)", () => {
  it("draws every claimed cause the answer returns, with its money, basis, runs and reason", () => {
    waste(CLAIMED);
    const repeated = causes().querySelector('li[data-cause="repeated_calls"]');
    if (!(repeated instanceof HTMLElement)) throw new Error("no repeated calls");
    expect(repeated.getAttribute("data-recorded")).toBe("true");
    expect(repeated).toHaveTextContent("repeated calls");
    expect(repeated).toHaveTextContent("$30.22");
    expect(repeated).toHaveTextContent("2 runs");
    expect(repeated).toHaveTextContent("client_attested");
    expect(repeated).toHaveTextContent(
      "a request only repeated tool calls or shell commands",
    );
    const retry = causes().querySelector('li[data-cause="retry_loops"]');
    expect(retry).toHaveTextContent("$0.59");
    expect(screen.getByText("Wasted").closest("div")).toHaveTextContent(
      "$31.22",
    );
    // The largest cause is named by its label, with the runs it cites.
    const largest = screen.getByText("Largest cause").closest("div");
    expect(largest).toHaveTextContent("repeated calls");
    expect(largest).toHaveTextContent("2 runs");
  });

  it("drops the retry loops row the claimed cause records, and keeps the causes no detector meters as not recorded", () => {
    waste(CLAIMED);
    expect(designRows()).toEqual([
      "cacheMisses",
      "correctivePrompts",
      "contextBloat",
      "idleWhileParked",
      "haltedEarly",
    ]);
    expect(
      causes().querySelectorAll('li[data-cause="retry_loops"]'),
    ).toHaveLength(1);
  });

  it("drops halted early once spend with no outcome is recorded", () => {
    waste({
      ...NOTHING,
      wasted: usd("100", "client_attested"),
      runsWithWaste: 1,
      largestCause: "spend_with_no_outcome",
      causes: [
        {
          cause: "spend_with_no_outcome",
          wasted: usd("100", "client_attested"),
          runs: 1,
          provingRuns: [{ runId: "tse_01k5rn9ddd", name: null }],
        },
      ],
    });
    expect(designRows()).not.toContain("haltedEarly");
    expect(designRows()).toContain("retryLoops");
  });

  it("cards each run with the cause it proves", () => {
    waste(CLAIMED);
    const card = document.querySelector('[data-run="tse_01k5rn9aaa"]');
    if (!(card instanceof HTMLElement)) throw new Error("no run card");
    expect(card).toHaveTextContent("Repair the login redirect");
    expect(card).toHaveTextContent("repeated calls");
    expect(within(card).getByRole("link", { name: "Open the run" })).toBeTruthy();
    expect(document.querySelectorAll("[data-run]")).toHaveLength(4);
  });

  it("says the claimed calls add up to the Findings tab's unproductive spend", () => {
    waste(CLAIMED);
    expect(causes()).toHaveTextContent(
      "The claimed calls add up to the unproductive spend on the Findings tab.",
    );
  });

  it("names no findings outside the period while claimed calls ran inside it", () => {
    waste(CLAIMED);
    expect(screen.queryByTestId("waste-outside")).toBeNull();
  });
});

describe("Wasted spend with no claimed call in the period (#5294)", () => {
  it("says how many open findings claim calls outside the period and links to them", () => {
    waste({ ...NOTHING, findingsOutsidePeriod: 4 });
    const line = screen.getByTestId("waste-outside");
    expect(line).toHaveTextContent(
      "4 open findings claim calls outside this period.",
    );
    expect(
      within(line).getByRole("link", { name: "Open the findings" }),
    ).toHaveAttribute("href", "/acme/core-platform/spend/findings");
    // The tiles still print no zero they were not given.
    expect(screen.getByText("No waste found")).toBeTruthy();
    expect(document.body).not.toHaveTextContent("$0");
  });

  it("names one open finding in the singular", () => {
    waste({ ...NOTHING, findingsOutsidePeriod: 1 });
    expect(screen.getByTestId("waste-outside")).toHaveTextContent(
      "1 open finding claims calls outside this period.",
    );
  });

  it("names the findings outside beside a cache-write cause, since no claimed call ran in the period", () => {
    waste({
      ...NOTHING,
      wasted: usd("410000", "client_attested"),
      runsWithWaste: 1,
      largestCause: "cache_write_never_read",
      findingsOutsidePeriod: 4,
      causes: [
        {
          cause: "cache_write_never_read",
          wasted: usd("410000", "client_attested"),
          runs: 1,
          provingRuns: [{ runId: "arun_01k5rn8f3j", name: null }],
        },
      ],
    });
    expect(screen.getByTestId("waste-outside")).toBeTruthy();
  });
});
