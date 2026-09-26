// @vitest-environment jsdom
// The Tokens tab when little is recorded: a month with no tokens prints no
// share it would have to divide by zero for, an agent with no runs has no
// per-run figure, a row with no cost names no basis, and an agents read that
// failed says so in its panel and nowhere else.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import type { SpendReport } from "@/data/contracts/spend";
import { readError, readOk } from "@/data/read";
import { IntlProvider } from "@/test/intl";
import { TokensSection } from "./tokens";

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
};

const report = (rows: SpendReport["rows"]): SpendReport => ({
  period: { from: "2026-09-01", to: "2026-09-15" },
  total: {
    cost: null,
    calls: 0,
    runs: 0,
    proven: null,
    accepted: null,
    productiveRatio: null,
  },
  rows,
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Tokens", () => {
  it("prints no share of a month with no tokens, and nothing per run for an agent with no runs", () => {
    render(
      <IntlProvider>
        <TokensSection
          month={report([])}
          agents={readOk(
            report([
              {
                key: "a-intel.core.stella-ci",
                cost: null,
                calls: 0,
                runs: 0,
                proven: null,
                accepted: null,
                productiveRatio: null,
                tokens: { ...NO_TOKENS, output: 40 },
                provider: null,
                operator: null,
              },
            ]),
          )}
          at={AT}
        />
      </IntlProvider>,
    );
    const output = document.querySelector('tr[data-token-class="output"]');
    expect(output).not.toBeNull();
    expect(
      output?.querySelectorAll('[data-recorded="false"]').length,
    ).toBeGreaterThanOrEqual(2);
    const agent = document.querySelector(
      'tr[data-key="a-intel.core.stella-ci"]',
    );
    expect(agent).not.toBeNull();
    expect(
      within(agent instanceof HTMLElement ? agent : document.body).getByRole(
        "link",
      ),
    ).toHaveAttribute("href", "/acme/core-platform/agents/stella-ci");
    expect(agent?.textContent).toContain("not recorded");
  });

  // #3721. A web search is billed per request, so the month's searches are
  // counted beside the token classes and never inside their total or share.
  it("counts the month's web search requests apart from its tokens", () => {
    const row = (key: string, searches: number) => ({
      key,
      cost: null,
      calls: 1,
      runs: 1,
      proven: null,
      accepted: null,
      productiveRatio: null,
      tokens: { ...NO_TOKENS, input_uncached: 100, server_tool_request: searches },
      provider: "anthropic",
      operator: null,
    });
    render(
      <IntlProvider>
        <TokensSection
          month={report([row("claude-sonnet-5", 3), row("claude-haiku-5", 2)])}
          agents={readOk(report([]))}
          at={AT}
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("spend-searches")).toHaveTextContent(
      "5 requests, priced per request and kept out of the token total",
    );
    // The class total is the 200 input tokens alone.
    expect(document.body).toHaveTextContent("200 tokens");
    expect(
      document.querySelector('tr[data-token-class="server_tool_request"]'),
    ).toBeNull();
  });

  it("says the agents read failed in its own panel (negative)", () => {
    render(
      <IntlProvider>
        <TokensSection
          month={report([])}
          agents={readError("rollup_unavailable", 503)}
          at={AT}
        />
      </IntlProvider>,
    );
    expect(screen.getByText(/rollup_unavailable/)).toBeTruthy();
    expect(document.querySelector("tr[data-key]")).toBeNull();
  });
});
