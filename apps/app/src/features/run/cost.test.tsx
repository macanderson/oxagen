// @vitest-environment jsdom
// The Cost tab's own branches (spec pages/run.md Cost, §12.6, INV-10), proven
// on `CostSection` over hand-built rollups. The page test in run.test.tsx
// renders the one rollup its builder carries, so it reaches the ideal path and
// the not-rolled-up path and none of the partial ones below. Each of those is
// a place where a money figure could print a zero, a basis stronger than the
// record, or nothing at all:
//
// - a cost read the control plane refused names its failure, and the panels
//   that need the rollup are not drawn over it;
// - a rollup with no cost prints "not recorded" for the run's cost, its per
//   turn share and the token-class total, never $0.00;
// - a cost with no basis says the basis is not recorded, never a stronger one;
// - a live run's wall clock is read against the page's instant and says "so
//   far";
// - a run with no turns, no model call, no tool, no price entry or no tokens
//   says so in words.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunCost, RunTranscript } from "@/data/contracts/run";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { CostSection } from "./cost";
import {
  NOW,
  runCost,
  runRow,
  runTranscript,
  transcriptEntry,
} from "./run.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

afterEach(cleanup);

const PLACE = { org: "acme", ws: "core-platform", runId: "tse_7k2m9q" };

type Rollup = NonNullable<RunCost["rollup"]>;

/** The builder's rollup with the fields a test names replaced. */
function rollupWith(overrides: Partial<Rollup>): Read<RunCost> {
  const base = runCost().rollup;
  if (base === null) throw new Error("the builder carries a rollup");
  return readOk({ rollup: { ...base, ...overrides } });
}

function renderCost({
  read = readOk(runCost()),
  turns = readOk(runTranscript({ zoom: "turns", entries: [] })),
  run = runRow(),
  at = NOW,
}: {
  read?: Read<RunCost>;
  turns?: Read<RunTranscript>;
  run?: ReturnType<typeof runRow>;
  at?: number;
}) {
  return render(
    <IntlProvider>
      <CostSection
        run={run}
        read={read}
        turns={turns}
        steps={readOk(runTranscript({ entries: [] }))}
        at={at}
        place={PLACE}
      />
    </IntlProvider>,
  );
}

const instrument = (index: number) => {
  const all = screen.getAllByTestId("run-instrument");
  const one = all[index];
  if (one === undefined) throw new Error(`instrument ${String(index)} drawn`);
  return one;
};

describe("CostSection › refused read", () => {
  it("names the cost read's failure and draws no figure the rollup would carry (negative)", async () => {
    const { container } = renderCost({
      read: readError("rollup_unreachable", 502),
    });
    // Model fit never needs the rollup, so it still leads the tab.
    expect(screen.getByTestId("run-model-fit")).toBeInTheDocument();
    expect(screen.queryByTestId("run-instrument")).toBeNull();
    expect(screen.queryByTestId("cost-not-rolled-up")).toBeNull();
    expect(screen.queryByTestId("cost-class-row")).toBeNull();
    expect(screen.queryByTestId("cost-family-row")).toBeNull();
    expect(screen.queryByText("This run called no tool.")).toBeNull();
    // Cost and Spend by area each carry the failure, with its code, in place
    // of a figure.
    const failures = container.querySelectorAll('[data-reason="error"]');
    expect(failures).toHaveLength(2);
    for (const failure of failures)
      expect(failure).toHaveTextContent("rollup_unreachable");
    await expectNoAxe(container);
  });
});

describe("CostSection › a rollup with no cost", () => {
  it("prints not recorded for the cost, its per-turn share and the class total, never $0.00 (negative)", () => {
    renderCost({ read: rollupWith({ cost: null }) });
    const cost = instrument(0);
    expect(cost).toHaveTextContent(/^Cost so farnot recorded/);
    expect(cost).toHaveTextContent("per turn not recorded");
    expect(cost).not.toHaveTextContent("$");
    expect(screen.getByTestId("cost-class-total")).toHaveTextContent(
      "not recorded",
    );
    expect(screen.queryByTestId("cost-class-basis")).toBeNull();
  });

  it("says the basis is not recorded when the rollup priced the run on none", () => {
    renderCost({
      read: rollupWith({
        cost: { micros: "4131265", currency: "USD", basis: null },
      }),
    });
    expect(screen.getByTestId("cost-class-basis")).toHaveTextContent(
      "basis not recorded",
    );
    // The instrument draws no basis line rather than a borrowed one.
    expect(instrument(0)).not.toHaveTextContent("gateway_observed");
    expect(instrument(0)).toHaveTextContent("$4.13");
  });

  it("divides the cost by the recorded turns for the per-turn share", () => {
    renderCost({
      read: rollupWith({
        cost: { micros: "4000000", currency: "USD", basis: "gateway_observed" },
        turns: 4,
      }),
    });
    expect(instrument(0)).toHaveTextContent("per turn $1.00");
  });
});

describe("CostSection › the dearest turn and the per-turn chart", () => {
  const usd = (micros: string) => ({
    micros,
    currency: "USD" as const,
    basis: "gateway_observed" as const,
  });

  it("names the dearest priced turn and draws one column per priced turn", () => {
    renderCost({
      turns: readOk(
        runTranscript({
          zoom: "turns",
          entries: [
            transcriptEntry({ seq: "1", label: "turn 1", cost: usd("900") }),
            transcriptEntry({ seq: "2", label: "turn 2", cost: null }),
            transcriptEntry({
              seq: "3",
              label: "turn 3",
              cost: usd("2500000"),
            }),
          ],
        }),
      ),
    });
    expect(instrument(0)).toHaveTextContent("dearest turn turn 3 $2.50");
    const chart = screen.getByTestId("instrument-per-turn");
    expect(chart).toHaveAccessibleName("Cost of each of 2 priced turns");
    const columns = [...chart.querySelectorAll<HTMLElement>(":scope > *")].map(
      (column) => column.style.height,
    );
    // The dearest is the full height; a cheap turn keeps a visible floor.
    expect(columns).toEqual(["8%", "100%"]);
  });

  it("names no dearest turn and draws no chart when no turn carries a cost (negative)", () => {
    renderCost({
      turns: readOk(
        runTranscript({
          zoom: "turns",
          entries: [transcriptEntry({ cost: null })],
        }),
      ),
    });
    expect(instrument(0)).toHaveTextContent("dearest turn not recorded");
    expect(screen.queryByTestId("instrument-per-turn")).toBeNull();
  });

  it("names no dearest turn when the turns read failed (negative)", () => {
    renderCost({
      turns: readError("transcript_unreachable", 502),
    });
    expect(instrument(0)).toHaveTextContent("dearest turn not recorded");
    expect(screen.queryByTestId("instrument-per-turn")).toBeNull();
  });
});

describe("CostSection › wall clock", () => {
  it("reads a live run against the page's instant and says so far", () => {
    renderCost({
      run: runRow({
        status: "live",
        sealedAt: null,
        startedAt: new Date(NOW - 90_000).toISOString(),
      }),
    });
    const wall = instrument(1);
    expect(wall).toHaveTextContent("so far");
    expect(wall).not.toHaveTextContent("start to seal");
  });

  it("reads an ended run from start to seal", () => {
    renderCost({});
    expect(instrument(1)).toHaveTextContent("start to seal");
  });
});

describe("CostSection › a rollup that counted nothing", () => {
  it("says so in words for no turns, no model call, no tool, no price entry and no tokens (negative)", () => {
    renderCost({
      read: rollupWith({
        turns: null,
        modelCalls: 0,
        toolCalls: 0,
        byTool: [],
        priceEntryIds: [],
        cacheHitRate: null,
        productiveRatio: null,
        tokens: {
          inputUncached: 0,
          cacheRead: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          output: 0,
          reasoning: 0,
        },
      }),
    });
    // No turn count: the per-turn share, the shape's turns and steps per turn
    // are not printed as a division by zero.
    expect(instrument(0)).toHaveTextContent("per turn not recorded");
    expect(instrument(0)).toHaveTextContent("cache hit not recorded");
    expect(instrument(3)).toHaveTextContent("– turns · 96 steps · 431 frames");
    expect(instrument(3)).not.toHaveTextContent("steps per turn");
    expect(instrument(2)).toHaveTextContent("no model call recorded");
    expect(instrument(4)).toHaveTextContent("0 families");
    expect(instrument(5)).toHaveTextContent(/^Productive rationot recorded/);
    // Tool calls says it in the family table's place (Spend by area's list of
    // dearest tools says the same beside it).
    const byFamily = screen.getByRole("heading", { name: "Calls by family" });
    expect(byFamily.parentElement).toHaveTextContent(
      "This run called no tool.",
    );
    expect(screen.queryByTestId("cost-family-row")).toBeNull();
    expect(
      screen.getByText(/priced with no price entry recorded/),
    ).toBeTruthy();
    // No tokens: every share is not recorded, and the total row claims no 100%.
    for (const row of screen.getAllByTestId("cost-class-row")) {
      expect(row).toHaveTextContent("not recorded");
      expect(row).not.toHaveTextContent("%");
    }
    expect(screen.getByTestId("cost-class-total")).not.toHaveTextContent(
      "100%",
    );
  });

  it("treats a rollup of zero turns as no per-turn figure, rather than dividing by it (negative)", () => {
    renderCost({ read: rollupWith({ turns: 0 }) });
    expect(instrument(0)).toHaveTextContent("per turn not recorded");
    expect(instrument(3)).toHaveTextContent("0 turns");
    expect(instrument(3)).not.toHaveTextContent("steps per turn");
  });

  it("prints steps per turn and tokens per model call with the rollup's own counts", () => {
    renderCost({});
    // 96 steps over 12 turns; 128,343 tokens over 54 calls.
    expect(instrument(3)).toHaveTextContent("8.0 steps per turn");
    expect(instrument(2)).toHaveTextContent("2,377 per model call");
    expect(instrument(4)).toHaveTextContent("1 family");
  });
});

describe("CostSection › tool calls by family", () => {
  it("sums calls per family, dearest first, with each family's share of the calls", () => {
    renderCost({
      read: rollupWith({
        byTool: [
          { name: "github__open_pr", calls: 1 },
          { name: "shell", calls: 6 },
          { name: "github__comment", calls: 3 },
        ],
      }),
    });
    const rows = screen.getAllByTestId("cost-family-row");
    expect(rows).toHaveLength(2);
    const cells = rows.map((row) =>
      [...row.querySelectorAll("td")].slice(0, 3).map((td) => td.textContent),
    );
    // The families come from `toolFamily`; the order is by calls, and the two
    // shares add to the whole.
    expect(cells.map((c) => c[1])).toEqual(["6", "4"]);
    expect(cells.map((c) => c[2])).toEqual(["60%", "40%"]);
    // No store records a family's wall clock or its failures (G6).
    for (const row of rows) {
      expect(within(row).getAllByText("not recorded")).toHaveLength(2);
    }
  });
});
