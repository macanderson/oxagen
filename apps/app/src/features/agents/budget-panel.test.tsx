// @vitest-environment jsdom
// The agent's Budgets panel: the ceilings it runs under with the basis of
// every figure, the line that says no per-agent ceiling is recorded, and the
// link to the page that sets one. Read-only in every state, including the ones
// where the read failed.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpendBudgets } from "@/data/contracts/spend";
import { type Read, readError, readOk } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { nth } from "@/test/nth";
import { spendBudgets } from "./agents.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

const { BudgetSection } = await import("./budget-panel");

const SPEND = routes.spend("acme", "core-platform", { tab: "budgets" });

function renderPanel(read: Read<SpendBudgets>) {
  render(
    <IntlProvider>
      <BudgetSection read={read} spend={SPEND} />
    </IntlProvider>,
  );
  return screen.getByRole("region", { name: "Budgets" });
}

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("BudgetSection", () => {
  it("shows each ceiling, its spend, its position, and the basis of the figures", () => {
    const panel = renderPanel(
      readOk([
        ...spendBudgets(),
        {
          scope: "org",
          enabled: true,
          period: "rolling",
          windowDays: 30,
          limit: { micros: "2000000000", currency: "USD" },
          spent: { micros: "1900000000", currency: "USD" },
          ratio: 0.95,
          state: "threshold_95",
        },
      ]),
    );
    const rows = within(panel).getAllByRole("row").slice(1);
    expect(
      rows.map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((c) => c.textContent),
      ),
    ).toEqual([
      ["Monthly", "$500.00", "$125.00", "25% · under the ceiling"],
      ["Rolling 30 days", "$2,000.00", "$1,900.00", "95% · past 95%"],
    ]);
    expect(panel).toHaveTextContent("Spent is metered from priced model calls");
  });

  it("says a ceiling that is not enforced is not enforced, rather than printing a percentage (negative)", () => {
    // A disabled ceiling is a documented no-op, and a percentage beside it
    // would read as a bound that is holding.
    const panel = renderPanel(readOk(spendBudgets({ enabled: false })));
    const [row] = within(panel).getAllByRole("row").slice(1);
    expect(row).toHaveTextContent("Not enforced");
    expect(row).not.toHaveTextContent("25%");
  });

  it("says there is no ceiling rather than showing a limit of zero (negative)", () => {
    const panel = renderPanel(
      readOk(spendBudgets({ limit: null, ratio: 0, state: "ok" })),
    );
    const row = nth(within(panel).getAllByRole("row"), 1, "the ceiling row");
    expect(
      nth(within(row).getAllByRole("cell"), 1, "the limit cell"),
    ).toHaveTextContent("No ceiling");
  });

  it("names the per-agent gap and links to where a ceiling is set", () => {
    const panel = renderPanel(readOk(spendBudgets()));
    expect(
      within(panel).getByTestId("agent-budget-not-backed"),
    ).toHaveTextContent("Oxagen records no ceiling for one agent");
    expect(
      within(panel).getByRole("link", { name: "Set ceilings on Spend" }),
    ).toHaveAttribute("href", "/acme/core-platform/spend?tab=budgets");
  });

  it("keeps that line when no ceiling is configured at all (empty)", () => {
    const panel = renderPanel(readOk([]));
    expect(within(panel).getByTestId("budgets-empty")).toHaveTextContent(
      "No spend ceiling is set for this workspace or its organization.",
    );
    expect(
      within(panel).getByTestId("agent-budget-not-backed"),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole("table")).not.toBeInTheDocument();
  });

  it("names a denied read with the permission it wanted, and draws no table (denied)", () => {
    const panel = renderPanel({
      ok: false,
      reason: "denied",
      permission: "spend.read",
    });
    expect(panel).toHaveTextContent("spend.read");
    expect(within(panel).queryByRole("table")).not.toBeInTheDocument();
  });

  it("names a failed read by its code (error)", () => {
    const panel = renderPanel(readError("rollup_rebuild_in_progress", 504));
    expect(panel).toHaveTextContent("rollup_rebuild_in_progress");
    expect(within(panel).queryByRole("table")).not.toBeInTheDocument();
  });

  it("offers no control that would set a ceiling here (negative)", () => {
    // `get_spend_budget`'s scope is org or workspace and nothing narrower, so
    // a Set budget control on this panel would claim a bound no store records.
    const panel = renderPanel(readOk(spendBudgets()));
    expect(within(panel).queryAllByRole("button")).toEqual([]);
  });
});
