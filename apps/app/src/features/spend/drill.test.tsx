// @vitest-environment jsdom
// One key's drill when little is recorded: a window whose days carry no
// priced run draws a flat line with no peak day, findings that could not be
// read are said twice (the savings figure and the findings panel) rather
// than read as "no finding", a key whose runs called no tools says so, and an
// operator the rollup cannot name is shown by their key.
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import type { SpendDrill } from "@/data/contracts/spend";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { DrillSection } from "./drill";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

const AT = { org: "acme", ws: "core-platform" };

const drill = (over: Partial<SpendDrill> = {}): SpendDrill => ({
  kind: "operator",
  key: "prn_ghost",
  period: { from: "2026-09-01", to: "2026-09-15" },
  total: {
    cost: null,
    calls: 0,
    runs: 0,
    proven: null,
    accepted: null,
    productiveRatio: null,
  },
  series: [{ day: "2026-09-01", cost: null, calls: 0, runs: 0 }],
  perCall: null,
  perRun: null,
  share: null,
  tools: [],
  ...over,
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the drill", () => {
  it("names an operator the rollup cannot name by their key, and says what could not be read", async () => {
    const { container } = render(
      <IntlProvider>
        <DrillSection drill={drill()} findings={null} operator={null} at={AT} />
      </IntlProvider>,
    );
    expect(document.querySelector('[aria-current="page"]')?.textContent).toBe(
      "prn_ghost",
    );
    expect(
      screen.getAllByText("The findings could not be read.").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByText("Its runs called no tools in this window."),
    ).toBeTruthy();
    // No day was priced, so no peak day is named and no share is printed.
    expect(document.body).not.toHaveTextContent(" on 2026-09-01");
    expect(document.body).not.toHaveTextContent("of the workspace");
    const line = document
      .querySelector("#spend-drill-days")
      ?.closest("section")
      ?.querySelector("polyline");
    expect(line?.getAttribute("points")).toBe("0,48");
    await expectNoAxe(container);
  });

  it("says no finding names the key when the findings read answered with none", async () => {
    const { container } = render(
      <IntlProvider>
        <DrillSection
          drill={drill({ kind: "agent", key: "a-intel.core.stella-ci" })}
          findings={[]}
          operator={null}
          at={AT}
        />
      </IntlProvider>,
    );
    expect(screen.getByText("No open finding names this key.")).toBeTruthy();
    expect(screen.getByText("none identified")).toBeTruthy();
    await expectNoAxe(container);
  });
});
