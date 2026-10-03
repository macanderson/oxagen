// @vitest-environment jsdom
// One key's drill when little is recorded: a window whose days carry no
// priced run draws no chart and names no peak day, findings that could not be
// read are said twice (the savings figure and the findings panel) rather
// than read as "no finding", a key whose runs called no tools says so, and an
// operator the rollup cannot name is shown by their key.
//
// And when the response carries the figures (#5293): a tool's drill prints
// its results' estimated cost with the estimated basis, its result tokens
// and its averages, and says the runs already paid that input; a tool whose
// calls recorded no result keeps those figures "not recorded"; each kind's
// tiles read the tokens, cache hit rate, model calls, gateway share and
// standing context; and the cross-cuts are tables of the rows the response
// carries.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import type { DrillCutRow, SpendDrill } from "@/data/contracts/spend";
import { IntlProvider } from "@/test/intl";
import { DrillSection } from "./drill";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

const AT = { org: "acme", ws: "core-platform" };

const NO_TOKENS = {
  input_uncached: 0,
  cache_read: 0,
  cache_write_5m: 0,
  cache_write_1h: 0,
  output: 0,
  reasoning: 0,
  server_tool_request: 0,
};

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
  tokens: NO_TOKENS,
  cacheHitRate: null,
  modelCalls: 0,
  observed: null,
  standing: {
    toolDefinitionTokens: null,
    contextFrameTokens: null,
    steeringTokens: null,
  },
  resultTokens: null,
  tools: [],
  byAgent: [],
  byOperator: [],
  byModel: [],
  ...over,
});

const ESTIMATED = {
  micros: "2400000",
  currency: "USD",
  basis: "estimated",
} as const;

const cutRow = (over: Partial<DrillCutRow> = {}): DrillCutRow => ({
  key: "acme.core.triage",
  provider: null,
  operator: null,
  runs: 1,
  calls: 5,
  cost: null,
  tokens: NO_TOKENS,
  resultTokens: null,
  ...over,
});

/** The tile whose term reads `term`: its value and its note. */
function tile(term: string): HTMLElement {
  const box = screen.getByText(term, { selector: "dt" }).closest("div");
  if (box === null) throw new Error(`no tile ${term}`);
  return box;
}

function panelOf(heading: string): HTMLElement {
  const panel = screen.getByRole("heading", { name: heading }).closest("section");
  if (panel === null) throw new Error(`no panel ${heading}`);
  return panel;
}

function rowOf(panel: HTMLElement, key: string): HTMLElement {
  const row = panel.querySelector<HTMLElement>(`tr[data-key="${key}"]`);
  if (row === null) throw new Error(`no row ${key}`);
  return row;
}

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the drill", () => {
  it("names an operator the rollup cannot name by their key, and says what could not be read", () => {
    render(
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
    // With no priced day there is nothing to plot, so the panel says so
    // rather than drawing an empty chart or a line along zero.
    const days = document.querySelector("#spend-drill-days")?.closest("section");
    expect(days).toHaveTextContent(
      "No day in this window carries a priced run.",
    );
    expect(days?.querySelector('[data-slot="chart"]')).toBeNull();
    // No run named an agent or made a model call, and each cut says so.
    expect(panelOf("By agent")).toHaveTextContent(
      "No run in this window names an agent.",
    );
    expect(panelOf("By model")).toHaveTextContent(
      "No run in this window made a model call.",
    );
    // A figure nothing measured reads as not recorded, never a zero.
    expect(tile("Cache hit rate")).toHaveTextContent("not recorded");
    expect(tile("Observed")).toHaveTextContent("not recorded");
  });

  it("says no finding names the key when the findings read answered with none", () => {
    render(
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
    // No run measured the tool definitions it carried.
    expect(tile("Tool definitions")).toHaveTextContent("not recorded");
    expect(tile("Tool definitions")).not.toHaveTextContent(
      "Tokens across its model calls",
    );
  });

  // #3304. A key whose runs include some that reported no usage has a total
  // that leaves their cost out, and the drill says so beside the counts.
  it("says how many of the key's runs reported no usage", () => {
    render(
      <IntlProvider>
        <DrillSection
          drill={drill({
            kind: "agent",
            key: "a-intel.core.codex-ci",
            unmeteredRuns: {
              total: 1,
              byHarness: [{ harness: "codex", runs: 1 }],
            },
          })}
          findings={[]}
          operator={null}
          at={AT}
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("spend-drill-unmetered")).toHaveTextContent(
      "1 run reported no usage and is not in this total: codex 1",
    );
  });
});

describe("a tool's drill (#5293)", () => {
  const toolDrill = drill({
    kind: "tool",
    key: "Bash",
    total: {
      cost: ESTIMATED,
      calls: 5,
      runs: 1,
      proven: null,
      accepted: null,
      productiveRatio: null,
    },
    series: [{ day: "2026-09-15", cost: ESTIMATED, calls: 5, runs: 1 }],
    perCall: { micros: "480000", currency: "USD" },
    perRun: { micros: "2400000", currency: "USD" },
    tokens: { ...NO_TOKENS, input_uncached: 600, cache_read: 400 },
    cacheHitRate: 0.4,
    resultTokens: 800,
    byAgent: [
      cutRow({ cost: ESTIMATED, resultTokens: 800, key: "acme.core.triage" }),
    ],
    byOperator: [
      cutRow({
        key: "prn_marcusbell",
        operator: {
          id: "prn_marcusbell",
          name: "Marcus Bell",
          email: null,
          avatarUrl: null,
          role: null,
        },
        cost: ESTIMATED,
        resultTokens: 800,
      }),
    ],
  });

  it("prints its results' estimated cost with the estimated basis, its averages and its result tokens, and says its runs already paid that input", () => {
    render(
      <IntlProvider>
        <DrillSection
          drill={toolDrill}
          findings={[]}
          operator={null}
          at={AT}
          harnesses={{ "acme.core.triage": "claude-code" }}
        />
      </IntlProvider>,
    );
    const spend = tile("Spend");
    expect(spend).toHaveTextContent("$2.40");
    expect(spend.querySelector('[data-basis="estimated"]')).not.toBeNull();
    expect(spend).toHaveTextContent("Cost of its results in later prompts");
    expect(tile("Average per call")).toHaveTextContent("$0.48");
    expect(tile("Average per run")).toHaveTextContent("$2.40");
    expect(tile("Result body")).toHaveTextContent("800");
    expect(tile("Result body")).toHaveTextContent("Tokens its results carried");
    // The cache hit rate is its runs', and the tile says so.
    expect(tile("Cache hit rate")).toHaveTextContent("40%");
    expect(tile("Cache hit rate")).toHaveTextContent(
      "Over the runs that called it",
    );
    // No source records a tool's repeat calls or retries yet.
    expect(tile("Repeat calls")).toHaveTextContent("not recorded");
    expect(tile("Retries")).toHaveTextContent("not recorded");
    // Spend by day plots the estimate and says what it is.
    expect(
      screen.getByRole("img", {
        name: "Spend by day from 2026-09-01 to 2026-09-15",
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("spend-drill-estimate")).toHaveTextContent(
      "Its runs already paid for this input.",
    );
    // The estimate is part of its runs' cost: no share of the workspace.
    expect(document.body).not.toHaveTextContent("of the workspace");
  });

  it("splits the tool's figure by agent and by operator, with no By tool or By model panel", () => {
    render(
      <IntlProvider>
        <DrillSection
          drill={toolDrill}
          findings={[]}
          operator={null}
          at={AT}
          harnesses={{ "acme.core.triage": "claude-code" }}
        />
      </IntlProvider>,
    );
    const agents = panelOf("By agent");
    const headers = within(agents)
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(headers).toEqual([
      "Agent",
      "Runs",
      "Calls",
      "Result tokens",
      "Result cost",
    ]);
    const triage = rowOf(agents, "acme.core.triage");
    expect(triage).toHaveTextContent("800");
    expect(triage).toHaveTextContent("$2.40");
    expect(
      triage.querySelector('[data-harness-badge="claude-code"]'),
    ).not.toBeNull();
    expect(within(triage).getByRole("link")).toHaveAttribute(
      "href",
      "/acme/core-platform/spend/agent/acme.core.triage",
    );
    const operators = panelOf("By operator");
    expect(rowOf(operators, "prn_marcusbell")).toHaveTextContent("Marcus Bell");
    expect(screen.queryByRole("heading", { name: "By tool" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "By model" })).toBeNull();
  });

  it("keeps the money and the result tokens not recorded when no call recorded a result (negative)", () => {
    render(
      <IntlProvider>
        <DrillSection
          drill={drill({
            kind: "tool",
            key: "Bash",
            total: {
              cost: null,
              calls: 4,
              runs: 1,
              proven: null,
              accepted: null,
              productiveRatio: null,
            },
            byAgent: [cutRow({ calls: 4 })],
          })}
          findings={[]}
          operator={null}
          at={AT}
        />
      </IntlProvider>,
    );
    expect(tile("Spend")).toHaveTextContent("not recorded");
    expect(tile("Average per call")).toHaveTextContent("not recorded");
    expect(tile("Average per run")).toHaveTextContent("not recorded");
    expect(tile("Result body")).toHaveTextContent("not recorded");
    expect(tile("Result body")).not.toHaveTextContent(
      "Tokens its results carried",
    );
    expect(tile("Calls")).toHaveTextContent("4");
    const triage = rowOf(panelOf("By agent"), "acme.core.triage");
    expect(triage.querySelectorAll('[data-recorded="false"]')).toHaveLength(2);
    expect(panelOf("By operator")).toHaveTextContent(
      "No run in this window names an operator.",
    );
  });
});

describe("an operator's and an agent's drill (#5293)", () => {
  it("reads the tokens, the cache hit rate, the model calls and the gateway's share, and splits by agent and model", () => {
    render(
      <IntlProvider>
        <DrillSection
          drill={drill({
            key: "prn_marcusbell",
            total: {
              cost: { micros: "3000000", currency: "USD", basis: "mixed" },
              calls: 12,
              runs: 3,
              proven: null,
              accepted: null,
              productiveRatio: null,
            },
            tokens: {
              ...NO_TOKENS,
              input_uncached: 2000,
              cache_read: 3000,
              output: 200,
            },
            cacheHitRate: 0.6,
            modelCalls: 6,
            observed: { micros: "2000000", currency: "USD" },
            byAgent: [
              cutRow({
                key: "acme.core.triage",
                runs: 2,
                calls: 8,
                cost: {
                  micros: "2000000",
                  currency: "USD",
                  basis: "gateway_observed",
                },
                tokens: { ...NO_TOKENS, input_uncached: 1000, output: 100 },
              }),
            ],
            byModel: [
              cutRow({
                key: "claude-sonnet-5",
                provider: "anthropic",
                runs: 3,
                calls: 6,
                cost: { micros: "3000000", currency: "USD", basis: "mixed" },
                tokens: { ...NO_TOKENS, input_uncached: 2000, output: 200 },
              }),
            ],
            byOperator: [
              cutRow({
                key: "prn_marcusbell",
                operator: {
                  id: "prn_marcusbell",
                  name: "Marcus Bell",
                  email: null,
                  avatarUrl: null,
                  role: null,
                },
              }),
            ],
          })}
          findings={[]}
          operator={null}
          at={AT}
          harnesses={{ "acme.core.triage": "codex" }}
        />
      </IntlProvider>,
    );
    // The page did not read the month's operators, so the drill's own By
    // operator row names the person.
    expect(
      screen.getByRole("heading", { level: 2, name: "Marcus Bell" }),
    ).toBeInTheDocument();
    expect(tile("Tokens")).toHaveTextContent("5,200");
    expect(tile("Cache hit rate")).toHaveTextContent("60%");
    // Model calls are the model calls, not the steps total.calls counts.
    expect(tile("Model calls")).toHaveTextContent("6");
    expect(tile("Model calls")).not.toHaveTextContent("12");
    expect(tile("Observed")).toHaveTextContent("66.7%");
    expect(tile("Observed")).toHaveTextContent("of priced spend");
    const agents = panelOf("By agent");
    const triage = rowOf(agents, "acme.core.triage");
    expect(triage).toHaveTextContent("1,100");
    expect(triage).toHaveTextContent("$2.00");
    expect(
      triage.querySelector('[data-basis="gateway_observed"]'),
    ).not.toBeNull();
    expect(triage.querySelector('[data-harness-badge="codex"]')).not.toBeNull();
    const model = rowOf(panelOf("By model"), "claude-sonnet-5");
    expect(model).toHaveTextContent("anthropic");
    expect(model).toHaveTextContent("2,200");
    expect(model).toHaveTextContent("$3.00");
    expect(screen.queryByRole("heading", { name: "By operator" })).toBeNull();
  });

  it("prints an agent's standing tool definitions and its tools' result tokens and cost", () => {
    render(
      <IntlProvider>
        <DrillSection
          drill={drill({
            kind: "agent",
            key: "acme.core.triage",
            standing: {
              toolDefinitionTokens: 61_000,
              contextFrameTokens: null,
              steeringTokens: null,
            },
            tools: [
              {
                name: "Bash",
                calls: 5,
                runs: 2,
                resultTokens: 800,
                cost: ESTIMATED,
              },
              {
                name: "Read",
                calls: 3,
                runs: 1,
                resultTokens: null,
                cost: null,
              },
            ],
          })}
          findings={[]}
          operator={null}
          at={AT}
        />
      </IntlProvider>,
    );
    expect(tile("Tool definitions")).toHaveTextContent("61,000");
    expect(tile("Tool definitions")).toHaveTextContent(
      "Tokens across its model calls",
    );
    const tools = panelOf("By tool");
    const bash = rowOf(tools, "Bash");
    expect(bash).toHaveTextContent("800");
    expect(bash).toHaveTextContent("$2.40");
    expect(bash.querySelector('[data-basis="estimated"]')).not.toBeNull();
    expect(within(bash).getByRole("link")).toHaveAttribute(
      "href",
      "/acme/core-platform/spend/tool/Bash",
    );
    // A tool whose calls recorded no result reads as not recorded.
    expect(
      rowOf(tools, "Read").querySelectorAll('[data-recorded="false"]'),
    ).toHaveLength(2);
    expect(tools).toHaveTextContent("Its runs already paid for this input.");
  });
});
