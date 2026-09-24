// @vitest-environment jsdom
// The Wasted spend tab when little or nothing is recorded: every tile says
// "not recorded" rather than printing a zero it was not given, a period with
// no waste says so, and a cause recorded against an unknown total draws no
// share bar it cannot compute.
import { cleanup, render, screen } from "@testing-library/react";
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
  period: { from: "2026-09-01", to: "2026-09-15" },
  total: {
    cost: null,
    calls: 0,
    runs: 12,
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

function waste(value: SpendWaste) {
  return render(
    <IntlProvider>
      <WasteSection waste={value} month={MONTH} at={AT} />
    </IntlProvider>,
  );
}

describe("Wasted spend", () => {
  it("says not recorded for the amount and share, no cause, and no run with waste", async () => {
    const { container } = waste({
      wasted: null,
      share: null,
      runsWithWaste: 0,
      largestCause: null,
      causes: [],
    });
    expect(
      document.querySelectorAll('[data-recorded="false"]').length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("No waste found")).toBeTruthy();
    expect(
      screen.getByText("No run in this period shows waste in its frames."),
    ).toBeTruthy();
    expect(document.body).not.toHaveTextContent("$0");
    await expectNoAxe(container);
  });

  it("draws a recorded cause with an empty share bar when the total wasted is not recorded, and no largest cause it cannot find", async () => {
    const { container } = waste({
      wasted: null,
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
          provingRuns: ["arun_01k5rn8f3j"],
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
    await expectNoAxe(container);

    cleanup();
    waste({
      wasted: null,
      share: null,
      runsWithWaste: 0,
      largestCause: "cache_write_never_read",
      causes: [],
    });
    expect(screen.getByText("No waste found")).toBeTruthy();
  });
});
