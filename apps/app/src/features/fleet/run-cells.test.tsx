// @vitest-environment jsdom
// The Runs panel's tokens cell and tile (#3834), the status word for paused
// and compacted rows (#3835), and a pull request's stored state (#4129), each
// rendered alone with an axe check.
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunRow } from "@/data/contracts/runs";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { runRow } from "./fleet.builders";
import {
  PullRequestsCell,
  RowStatusBadge,
  type RowWord,
  TokensCell,
  TokensTile,
} from "./run-cells";
import type { ListedRun } from "./view";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

afterEach(cleanup);

function renderIn(node: ReactNode, wrap: "table" | "div" = "div") {
  return render(
    <IntlProvider>
      {wrap === "table" ? (
        <table>
          <tbody>
            <tr>
              <td>{node}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        node
      )}
    </IntlProvider>,
  );
}

const counts = {
  inputUncached: 1_000,
  cacheRead: 3_000,
  cacheWrite5m: 500,
  cacheWrite1h: 0,
  output: 400,
  reasoning: 100,
};
const usd = (micros: string) => ({
  micros,
  currency: "USD",
  basis: "gateway_observed" as const,
});
const listed = (runs: RunRow[]): ListedRun[] =>
  runs.map((run) => ({ run, state: "sealed" }));

describe("TokensCell", () => {
  it("shows the total with the share cached beneath (#3834)", async () => {
    const { container } = renderIn(
      <TokensCell run={runRow({ tokens: counts })} />,
      "table",
    );
    const cell = screen.getByTestId("row-tokens");
    expect(cell).toHaveAttribute("data-recorded", "true");
    expect(cell).toHaveAttribute("data-basis", "rollup");
    expect(cell).toHaveTextContent("5,000");
    expect(cell).toHaveTextContent("75% cached");
    await expectNoAxe(container);
  });

  it("labels the agent's own count while no rollup row exists", () => {
    renderIn(
      <TokensCell
        run={runRow({
          tokens: null,
          reportedTokens: {
            input: 100,
            output: 50,
            cacheRead: 300,
            cacheWrite: 50,
          },
        })}
      />,
      "table",
    );
    const cell = screen.getByTestId("row-tokens");
    expect(cell).toHaveAttribute("data-basis", "reported");
    expect(cell).toHaveTextContent("500");
    expect(cell).toHaveTextContent("reported");
    expect(cell.getAttribute("title")).toContain("agent's own count");
  });

  it("reads not recorded with neither figure, never 0 (negative)", () => {
    renderIn(
      <TokensCell run={runRow({ tokens: null, reportedTokens: null })} />,
      "table",
    );
    const cell = screen.getByTestId("row-tokens");
    expect(cell).toHaveAttribute("data-recorded", "false");
    expect(cell).toHaveTextContent("not recorded");
    expect(cell).not.toHaveTextContent("0");
  });
});

describe("TokensTile", () => {
  it("sums the rows listed, with the share served from cache weighted by spend", async () => {
    const { container } = renderIn(
      <TokensTile
        listed={listed([
          runRow({
            id: "arun_a",
            tokens: counts,
            cost: usd("3000000"),
            cacheHitRate: 0.9,
          }),
          runRow({
            id: "arun_b",
            tokens: counts,
            cost: usd("1000000"),
            cacheHitRate: 0.1,
          }),
        ])}
      />,
    );
    expect(screen.getByTestId("tokens-shown")).toHaveTextContent("10,000");
    expect(screen.getByTestId("tokens-cache")).toHaveTextContent(
      "70% served from cache",
    );
    await expectNoAxe(container);
  });

  it("says how many rows it left out and how many the agent counted", () => {
    renderIn(
      <TokensTile
        listed={listed([
          runRow({ id: "arun_a", tokens: counts, cacheHitRate: null }),
          runRow({
            id: "tse_b",
            tokens: null,
            reportedTokens: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
            },
          }),
          runRow({ id: "tse_c", tokens: null, reportedTokens: null }),
        ])}
      />,
    );
    const note = screen.getByTestId("tokens-cache");
    expect(note).toHaveTextContent("no cache figure recorded");
    expect(note).toHaveTextContent("1 row counted by its agent");
    expect(note).toHaveTextContent("1 row not recorded");
  });

  it("reads not recorded over rows with no figure, never 0 (negative)", () => {
    renderIn(
      <TokensTile
        listed={listed([runRow({ tokens: null, reportedTokens: null })])}
      />,
    );
    expect(screen.getByTestId("tokens-not-recorded")).toHaveTextContent(
      "not recorded",
    );
    expect(screen.queryByTestId("tokens-shown")).toBeNull();
  });
});

describe("RowStatusBadge", () => {
  it.each([
    ["paused", "paused", "live"],
    ["compacted", "compacted", "sealed"],
    ["parked", "parked for approval", "live"],
  ] as const)(
    "draws %s as its own word (#3835)",
    async (state, word, status) => {
      const { container } = renderIn(
        <RowStatusBadge
          run={runRow({
            status,
            outcome: status === "live" ? "running" : "completed",
          })}
          state={state satisfies RowWord}
        />,
        "table",
      );
      const badge = container.querySelector(`[data-status="${state}"]`);
      expect(badge).toHaveTextContent(word);
      await expectNoAxe(container);
    },
  );

  it("draws the lifecycle word for every other state", () => {
    const { container } = renderIn(
      <RowStatusBadge
        run={runRow({ status: "sealed", outcome: "completed" })}
        state="sealed"
      />,
      "table",
    );
    expect(container.querySelector('[data-status="sealed"]')).toHaveTextContent(
      "sealed",
    );
  });
});

describe("PullRequestsCell: stored state (#4129)", () => {
  it("shows the state a forge reported, with when Oxagen read it on hover", async () => {
    const { container } = renderIn(
      <PullRequestsCell
        run={runRow({
          source: "tacho",
          pullRequests: [
            {
              url: "https://github.com/acme/api/pull/42",
              number: 42,
              repository: "acme/api",
              state: "merged",
              stateSeenAt: "2026-09-25T10:00:00.000Z",
            },
          ],
        })}
      />,
      "table",
    );
    const state = screen.getByTestId("row-pr-state");
    expect(state).toHaveAttribute("data-state", "merged");
    expect(state.getAttribute("title")).toMatch(/^Status as of Sep 25, 2026/);
    await expectNoAxe(container);
  });

  it("says status unknown, and why, when no forge reported one (negative)", () => {
    renderIn(
      <PullRequestsCell
        run={runRow({
          source: "tacho",
          pullRequests: [
            {
              url: "https://github.com/acme/api/pull/42",
              number: 42,
              repository: "acme/api",
              state: null,
              stateSeenAt: null,
            },
          ],
        })}
      />,
      "table",
    );
    const state = screen.getByTestId("row-pr-state");
    expect(state).toHaveAttribute("data-state", "unknown");
    expect(state.getAttribute("title")).toContain("No forge has reported");
  });
});
