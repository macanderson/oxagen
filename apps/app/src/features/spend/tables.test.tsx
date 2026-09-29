// @vitest-environment jsdom
// The Spend tables when little is recorded: each level's empty sentence, a
// row with no cost and no tokens printing "not recorded" rather than a zero,
// savings that could not be read, and a budget with no ceiling, no window, or
// a position past eighty percent.
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import type { SpendBudgets, SpendReport } from "@/data/contracts/spend";
import { IntlProvider } from "@/test/intl";
import { BudgetsTable, TaskTable, ToolSection } from "./tables";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({ setBudgetAction: vi.fn() }));

const AT = { org: "acme", ws: "core-platform" };
const NO_TOKENS = {
  input_uncached: 0,
  cache_read: 0,
  cache_write_5m: 0,
  cache_write_1h: 0,
  output: 0,
  reasoning: 0,
};
const UNRECORDED = {
  cost: null,
  calls: 3,
  runs: 1,
  proven: null,
  accepted: null,
  productiveRatio: null,
};

const report = (rows: SpendReport["rows"]): SpendReport => ({
  period: { from: "2026-09-01", to: "2026-09-15" },
  total: UNRECORDED,
  rows,
});

/** A row with no cost, no tokens, no provider and no operator. */
const bare = (key: string): SpendReport["rows"][number] => ({
  ...UNRECORDED,
  key,
  tokens: NO_TOKENS,
  provider: null,
  operator: null,
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the level tables", () => {
  it("says each level recorded nothing in its own words", () => {
    render(
      <IntlProvider>
        <ToolSection report={report([])} findings={null} at={AT} />
        <TaskTable report={report([])} />
      </IntlProvider>,
    );
    for (const sentence of [
      "No tool call in this period has been rolled up.",
      "No run in this period names a task.",
    ])
      expect(screen.getByText(sentence)).toBeTruthy();
  });

  it("prints not recorded for a row with no cost and savings that could not be read", () => {
    render(
      <IntlProvider>
        <ToolSection
          report={report([bare("ghost_tool")])}
          findings={null}
          at={AT}
        />
      </IntlProvider>,
    );
    const row = document.querySelector('tr[data-key="ghost_tool"]');
    expect(row).not.toBeNull();
    expect(
      row?.querySelectorAll('[data-recorded="false"]').length,
    ).toBeGreaterThanOrEqual(2);
    expect(row?.textContent).not.toContain("$0");
  });
});

describe("the budgets table", () => {
  it("says no ceiling is set when there are no budgets", () => {
    render(
      <IntlProvider>
        <BudgetsTable budgets={[]} at={AT} />
      </IntlProvider>,
    );
    expect(
      screen.getByText(
        "No spend ceiling is set for this workspace or its organization.",
      ),
    ).toBeTruthy();
  });

  it("reads a budget with no ceiling and an unrecorded window, and one past eighty percent in red", () => {
    const budgets: SpendBudgets = [
      {
        scope: "workspace",
        enabled: true,
        period: "rolling",
        windowDays: null,
        limit: null,
        spent: { micros: "1000000", currency: "USD" },
        ratio: 0,
        state: "ok",
      },
      {
        scope: "org",
        enabled: true,
        period: "monthly",
        windowDays: null,
        limit: { micros: "10000000", currency: "USD" },
        spent: { micros: "9000000", currency: "USD" },
        ratio: 0.9,
        state: "threshold_80",
      },
    ];
    render(
      <IntlProvider>
        <BudgetsTable budgets={budgets} at={AT} />
      </IntlProvider>,
    );
    const workspace = document.querySelector('tr[data-scope="workspace"]');
    expect(workspace?.textContent).toContain("No ceiling");
    expect(workspace?.querySelector('[data-recorded="false"]')).not.toBeNull();
    const org = document.querySelector('tr[data-scope="org"]');
    expect(org?.querySelector(".bg-destructive[style]")).not.toBeNull();
  });
});
