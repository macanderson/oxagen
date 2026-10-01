// @vitest-environment jsdom
// The Findings hero leads with the month's unproductive spend and its share of
// the month's spend, side by side (counting rule 5), with what detectors 2, 3,
// and 5 price and what detector 4 estimates beside it and out of it (rules 2
// and 3). A read that did not answer says why in the hero, and the list still
// shows. When the listed total is unknown each card's share reads "not
// recorded" and never a guessed percentage, the list sorts by saving and by
// kind, an operator the rollup cannot name is shown by id, and a filter that
// hides every card says so. The pager under the cards holds Rows per page,
// turns to the next ten and shows every card at 25. Evidence with no runs
// says so, and closing it returns to the list.
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
  UnproductiveSpend,
} from "@/data/contracts/spend";
import { type Read, readError, readOk } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { IntlProvider } from "@/test/intl";
import { pickOption } from "@/test/select";

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

/** Twelve findings, largest saving first: two more than the first page holds. */
const TWELVE: SpendFinding[] = Array.from({ length: 12 }, (_, i) => ({
  id: `fnd_${String(i)}p`,
  kind: KINDS[i % KINDS.length] ?? "unpaged_results",
  level: "tool",
  subject: `tool_${String(i)}`,
  saving: {
    micros: String((12 - i) * 1_000_000),
    currency: "USD",
    basis: "gateway_observed",
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

const usd = (micros: string) => ({ micros, currency: "USD" });

/** $12.34 unproductive of $100.00 spent: 12.34%. */
const HEADLINE: UnproductiveSpend = {
  period: { from: "2026-09-01", to: "2026-09-15" },
  unproductive: usd("12340000"),
  spend: usd("100000000"),
  share: 0.1234,
  parts: [
    { detector: 2, saving: usd("4000000"), findings: 2 },
    { detector: 3, saving: usd("2500000"), findings: 1 },
    { detector: 5, saving: usd("6000000"), findings: 3 },
  ],
  estimate: { saving: usd("15000000"), findings: 4 },
};

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

function section(
  saving: SpendFindings["saving"],
  headline: Read<UnproductiveSpend> = readOk(HEADLINE),
) {
  render(
    <IntlProvider>
      <FindingsSection
        headline={headline}
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

describe("Findings hero", () => {
  it("leads with the headline and its share of the month's spend, side by side", () => {
    section(null);
    const hero = screen.getByTestId("spend-findings-hero");
    expect(
      within(hero).getByRole("heading", { name: "Unproductive spend" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("spend-headline")).toHaveTextContent("$12.34");
    expect(screen.getByTestId("spend-headline-share")).toHaveTextContent(
      /12(\.3)?%/,
    );
    expect(hero).toHaveTextContent(/of \$100(\.00)? spent this month\./);
    expect(hero).not.toHaveTextContent("Savings identified");
  });

  it("shows the parts and the estimate beside the headline and adds none of them to it", () => {
    section(null);
    const parts = screen.getByTestId("spend-headline-parts");
    const figure = (detector: string) => {
      const row = parts.querySelector(`[data-detector="${detector}"]`);
      if (row === null) throw new Error(`no detector ${detector}`);
      return row;
    };
    expect(figure("2")).toHaveTextContent("Standing context");
    expect(figure("2")).toHaveTextContent("$4.00");
    expect(figure("2")).toHaveTextContent("2 findings");
    expect(figure("3")).toHaveTextContent("Cache rewrites");
    expect(figure("3")).toHaveTextContent("1 finding");
    expect(figure("5")).toHaveTextContent("Context carry");
    expect(figure("4")).toHaveTextContent("Model class fit");
    expect(figure("4")).toHaveTextContent("Estimated");
    expect(figure("4")).toHaveTextContent("$15.00");
    // $4.00 + $2.50 + $6.00 + $15.00 is not added to the $12.34 headline.
    expect(screen.getByTestId("spend-headline")).toHaveTextContent("$12.34");
    expect(parts.parentElement).toHaveTextContent(
      /none of them adds to unproductive spend/,
    );
  });

  it("prints no share when the month's spend has no single figure (negative)", () => {
    section(null, readOk({ ...HEADLINE, spend: null, share: null }));
    expect(
      screen
        .getByTestId("spend-headline-share")
        .querySelector('[data-recorded="false"]'),
    ).not.toBeNull();
    expect(screen.getByTestId("spend-findings-hero")).toHaveTextContent(
      /so it shows no share/,
    );
  });

  it("says why no figure was built for a month in two currencies, and keeps the list (negative)", () => {
    section(null, readError("unproductive_mixed_currency", 409));
    const hero = screen.getByTestId("spend-findings-hero");
    expect(hero).toHaveTextContent(/more than one currency/);
    expect(screen.queryByTestId("spend-headline")).toBeNull();
    expect(screen.queryByTestId("spend-headline-parts")).toBeNull();
    expect(order()).toHaveLength(9);
  });

  it("says the headline did not answer in the hero, and keeps the list (negative)", () => {
    section(null, readError("findings_store_unavailable", 503));
    expect(screen.queryByTestId("spend-headline")).toBeNull();
    expect(order()).toHaveLength(9);
  });
});

describe("Findings with an unknown total", () => {
  it("prints no share it cannot divide for and names an unnamed operator by id", () => {
    section(null);
    const first = document.querySelector('li[data-finding="fnd_0a"]');
    expect(first?.textContent).toContain("prn_ghost");
    expect(first?.textContent).toContain("at stake");
    expect(first?.textContent).not.toMatch(/of identified/);
  });

  it("sorts by saving, high first, and by kind", async () => {
    const user = userEvent.setup();
    section(null);
    await pickOption(
      user,
      screen.getByRole("combobox", { name: "Sort" }),
      "Savings low first",
    );
    expect(order()[0]).toBe("fnd_8a");
    await pickOption(
      user,
      screen.getByRole("combobox", { name: "Sort" }),
      "Savings high first",
    );
    expect(order()[0]).toBe("fnd_0a");
    await pickOption(
      user,
      screen.getByRole("combobox", { name: "Sort" }),
      "Finding A to Z",
    );
    const kinds = Array.from(document.querySelectorAll("li[data-finding]")).map(
      (li) => li.getAttribute("data-finding"),
    );
    // "Cache written and never read" sorts first.
    expect(kinds[0]).toBe("fnd_3a");
  });

  it("says no finding matches when a filter hides every card (negative)", async () => {
    const user = userEvent.setup();
    section(null);
    await pickOption(
      user,
      screen.getByRole("combobox", { name: "Confidence" }),
      "medium confidence",
    );
    expect(screen.getByText("No finding matches these filters.")).toBeTruthy();
    expect(order()).toEqual([]);
  });
});

describe("Findings pager", () => {
  it("draws Rows under the cards, turns to the next ten, and shows every card at 25", async () => {
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <FindingsSection
          headline={readOk(HEADLINE)}
          findings={{
            window: WINDOW,
            saving: {
              micros: "78000000",
              currency: "USD",
              basis: "gateway_observed",
            },
            spend: null,
            share: null,
            annualised: null,
            counts: { findings: 12, high: 12, medium: 0, operators: 0 },
            findings: TWELVE,
          }}
          operators={[]}
          at={AT}
          evidence={null}
        />
      </IntlProvider>,
    );
    const list = screen.getByRole("list", {
      name: "Findings ranked by savings",
    });
    const rows = screen.getByRole("combobox", { name: "Rows" });
    const pager = rows.closest("[data-rows-pager]");
    if (pager === null) throw new Error("Rows sits outside the pager");
    // The pager, Rows with it, comes after the cards, not above them.
    expect(
      list.compareDocumentPosition(pager) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(rows).toHaveTextContent("10");
    expect(order()).toHaveLength(10);
    expect(pager).toHaveTextContent("1 to 10 of 12");
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(pager).toHaveTextContent("11 to 12 of 12");
    expect(order()).toEqual(["fnd_10p", "fnd_11p"]);
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    // A new size goes back to the first page.
    await user.click(rows);
    await user.click(await screen.findByRole("option", { name: "25" }));
    await waitFor(() => {
      expect(order()).toHaveLength(12);
    });
    expect(screen.getByRole("combobox", { name: "Rows" })).toHaveTextContent(
      "25",
    );
    expect(pager).toHaveTextContent("1 to 12 of 12");
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
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
      // Closing the evidence returns to the list on the Findings tab.
      expect(nav.replace).toHaveBeenCalledWith(
        "/acme/core-platform/spend/findings",
      );
    });
  });

  it("names an unnamed run Untitled session and keeps its id under it (#4571)", () => {
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
            runs: [
              {
                runId: "tse_7k2m9q",
                name: null,
                startedAt: "2026-09-11T06:00:00.000Z",
                calls: 2,
                measuredTokens: 100,
                counterfactualTokens: 40,
                measured: { micros: "3000000", currency: "USD" },
                counterfactual: { micros: "1000000", currency: "USD" },
              },
            ],
          })}
          at={AT}
        />
      </IntlProvider>,
    );
    const dialog = screen.getByTestId("spend-evidence-dialog");
    expect(
      within(dialog).getByRole("link", { name: "Untitled session" }),
    ).toHaveAttribute("href", "/acme/core-platform/runs/tse_7k2m9q");
    expect(within(dialog).getByTestId("run-id")).toHaveTextContent(
      /^tse_7k2m9q$/,
    );
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
