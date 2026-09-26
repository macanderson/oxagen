// @vitest-environment jsdom
// Findings when the listed total is unknown and there are more findings than
// the legend names: each share reads "not recorded" and never a guessed
// percentage, the smaller findings roll into one legend entry, the list sorts
// by saving and by kind, an operator the rollup cannot name is shown by id,
// and a filter that hides every card says so. Evidence with no runs says so,
// and closing it returns to the list.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import type {
  SpendFinding,
  SpendFindings,
  SpendReport,
} from "@/data/contracts/spend";
import { readOk } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { IntlProvider } from "@/test/intl";

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("./actions", () => ({
  recordFindingFixAction: vi.fn(),
  dismissFindingAction: vi.fn(),
}));

const { FindingEvidence, FindingsSection } = await import("./findings");

const AT = { org: "acme", ws: "core-platform" };
const WINDOW = {
  from: "2026-08-16T00:00:00.000Z",
  to: "2026-09-15T00:00:00.000Z",
};

const KINDS = [
  "unpaged_results",
  "duplicate_tool_calls",
  "repeated_shell_commands",
  "cache_writes_never_read",
] as const;

/** Nine findings, largest saving first, so one rolls into the legend's tail. */
const NINE: SpendFinding[] = Array.from({ length: 9 }, (_, i) => ({
  id: `fnd_${String(i)}a`,
  kind: KINDS[i % KINDS.length] ?? "unpaged_results",
  level: i === 0 ? "operator" : "tool",
  subject: i === 0 ? "prn_ghost" : `tool_${String(i)}`,
  saving: {
    micros: String((9 - i) * 1_000_000),
    currency: "USD",
    basis: i === 1 ? null : "gateway_observed",
  },
  confidence: "high",
  window: WINDOW,
  why: "Why.",
  fix: "Fix.",
  runs: 1,
  calls: 2,
}));

const listing = (saving: SpendFindings["saving"]): SpendFindings => ({
  window: WINDOW,
  saving,
  spend: null,
  share: null,
  annualised: null,
  counts: { findings: 9, high: 9, medium: 0, operators: 1 },
  findings: NINE,
});

/** The operator rollup names nobody: the row carries no name. */
const OPERATORS: SpendReport["rows"] = [
  {
    key: "prn_ghost",
    cost: null,
    calls: 0,
    runs: 0,
    proven: null,
    accepted: null,
    productiveRatio: null,
    tokens: {
      input_uncached: 0,
      cache_read: 0,
      cache_write_5m: 0,
      cache_write_1h: 0,
      output: 0,
      reasoning: 0,
    },
    provider: null,
    operator: {
      id: "prn_ghost",
      name: null,
      email: null,
      avatarUrl: null,
      role: null,
    },
  },
];

beforeEach(() => {
  nav.push.mockReset();
  nav.replace.mockReset();
});
afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function section(saving: SpendFindings["saving"]) {
  render(
    <IntlProvider>
      <FindingsSection
        findings={listing(saving)}
        operators={OPERATORS}
        at={AT}
        evidence={null}
      />
    </IntlProvider>,
  );
}

const order = () =>
  Array.from(document.querySelectorAll("li[data-finding]")).map((li) =>
    li.getAttribute("data-finding"),
  );

describe("Findings with an unknown total", () => {
  it("prints no share it cannot divide for, rolls the ninth into the legend's tail, and names an unnamed operator by id", () => {
    section(null);
    const hero = screen.getByTestId("spend-findings-hero");
    expect(hero.textContent).toContain("1 smaller findings");
    expect(
      hero.querySelectorAll('[data-recorded="false"]').length,
    ).toBeGreaterThanOrEqual(9);
    // No slice is drawn for a share nobody computed.
    expect(hero.querySelector("span[data-finding]")).toBeNull();
    const first = document.querySelector('li[data-finding="fnd_0a"]');
    expect(first?.textContent).toContain("prn_ghost");
    expect(first?.textContent).toContain("at stake");
  });

  it("sorts by saving, high first, and by kind", async () => {
    const user = userEvent.setup();
    section(null);
    await user.selectOptions(
      screen.getByLabelText("Sort"),
      "Savings low first",
    );
    expect(order()[0]).toBe("fnd_8a");
    await user.selectOptions(
      screen.getByLabelText("Sort"),
      "Savings high first",
    );
    expect(order()[0]).toBe("fnd_0a");
    await user.selectOptions(screen.getByLabelText("Sort"), "Finding A to Z");
    const kinds = Array.from(document.querySelectorAll("li[data-finding]")).map(
      (li) => li.getAttribute("data-finding"),
    );
    // "Cache written and never read" sorts first.
    expect(kinds[0]).toBe("fnd_3a");
  });

  it("says no finding matches when a filter hides every card (negative)", async () => {
    const user = userEvent.setup();
    section(null);
    await user.selectOptions(
      screen.getByLabelText("Confidence"),
      "medium confidence",
    );
    expect(screen.getByText("No finding matches these filters.")).toBeTruthy();
    expect(order()).toEqual([]);
  });
});

describe("Findings with a known total", () => {
  it("prints the tail's share as the sum of the findings it rolls up", () => {
    section({ micros: "45000000", currency: "USD", basis: "gateway_observed" });
    const hero = screen.getByTestId("spend-findings-hero");
    const tail = within(hero).getByText("1 smaller findings").closest("li");
    // The ninth finding saves 1 of 45.
    expect(tail?.textContent).toMatch(/2(\.\d)?%/);
    expect(hero.querySelectorAll("span[data-finding]")).toHaveLength(9);
  });
});

describe("Finding evidence", () => {
  it("says the evidence lists no run, and closing it returns to the list", async () => {
    const user = userEvent.setup();
    const finding = NINE[2];
    if (finding === undefined) throw new Error("fixture");
    render(
      <IntlProvider>
        <FindingEvidence
          evidence={readOk({
            finding,
            calls: 2,
            coveredCalls: 2,
            measuredTokens: 100,
            counterfactualTokens: 40,
            measured: { micros: "3000000", currency: "USD" },
            counterfactual: { micros: "1000000", currency: "USD" },
            runs: [],
          })}
          at={AT}
        />
      </IntlProvider>,
    );
    expect(
      screen.getByText("The evidence lists no run for this finding."),
    ).toBeTruthy();
    const dialog = screen.getByTestId("spend-evidence-dialog");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      // Findings is the default tab, so the list is the bare Spend path.
      expect(nav.replace).toHaveBeenCalledWith("/acme/core-platform/spend");
    });
  });

  it("returns to the page it opened over when that page names where (#4001)", async () => {
    const user = userEvent.setup();
    const finding = NINE[2];
    if (finding === undefined) throw new Error("fixture");
    render(
      <IntlProvider>
        <FindingEvidence
          evidence={readOk({
            finding,
            calls: 2,
            coveredCalls: 2,
            measuredTokens: 100,
            counterfactualTokens: 40,
            measured: { micros: "3000000", currency: "USD" },
            counterfactual: { micros: "1000000", currency: "USD" },
            runs: [],
          })}
          at={AT}
          close={routes.run(AT.org, AT.ws, "tse_7k2m9q", { tab: "cost" })}
        />
      </IntlProvider>,
    );
    const dialog = screen.getByTestId("spend-evidence-dialog");
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(nav.replace).toHaveBeenCalledWith(
        "/acme/core-platform/runs/tse_7k2m9q?tab=cost",
      );
    });
  });
});
