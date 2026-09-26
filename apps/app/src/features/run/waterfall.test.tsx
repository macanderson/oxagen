// @vitest-environment jsdom
// The run waterfall (spec §12.9; pages/run.md, Cost): one bar per turn on the
// dearest turn's scale, the cost accumulating across them, and the per-turn
// table with its total row, all read from the per-turn ledger `get_run_turns`
// answers (`turnFigures`) and `ledgerOf` sums.
//
// The rule these hold is the file's own: a turn whose cost the recording did
// not carry draws no bar and says "not recorded" in its Cost cell, because a
// zero-height bar would read as "this turn cost nothing", a measurement nobody
// made. The total row is the sum of the rows, set against the recorded cost.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunFindings, RunTurns } from "@/data/contracts/run";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  costTranscript,
  releaseRunCost,
  releaseRunTurns,
} from "./cost.builders";
import { ledgerOf } from "./cost-figures";
import { type RunMetrics, runMetrics, type TurnFigure } from "./metrics";
import { runRow } from "./run.builders";
import { WaterfallPanel } from "./waterfall";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

afterEach(cleanup);

const PLACE = { org: "acme", ws: "core-platform", runId: "tse_7k2m9q" };
const NO_FINDINGS: Read<RunFindings> = readOk({ findings: [] });

const usd = (micros: string) => ({
  micros,
  currency: "USD",
  basis: "gateway_observed" as const,
});

const TRANSCRIPT = readOk(costTranscript(releaseRunTurns()));

/** The release run's metrics, with the figures a test sets over them. */
function metrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    ...runMetrics({
      run: runRow({ cost: usd("4130000") }),
      cost: readOk(releaseRunCost()),
      transcript: TRANSCRIPT,
    }),
    ...overrides,
  };
}

function turn(overrides: Partial<TurnFigure>): TurnFigure {
  return {
    turn: 1,
    steps: 4,
    modelSteps: 2,
    toolSteps: 2,
    frames: 9,
    cost: usd("400000"),
    cacheHit: 0.87,
    seq: "1",
    ...overrides,
  };
}

/**
 * The panel over `turns`, as the Cost tab hands it: the ledger summed from
 * the rows, and whether the read reached the last turn. A failed `read` is
 * handed on as it is.
 */
function renderPanel(
  turns: TurnFigure[],
  {
    read = readOk<RunTurns>({ turns: [], complete: true, chains: [] }),
    overrides = {},
    findings = NO_FINDINGS,
  }: {
    read?: Read<RunTurns>;
    overrides?: Partial<RunMetrics>;
    /** `list_findings` for the run; a run no finding cites when absent. */
    findings?: Read<RunFindings>;
  } = {},
) {
  const m = metrics(overrides);
  return render(
    <IntlProvider>
      <WaterfallPanel
        metrics={m}
        turns={
          read.ok
            ? readOk({
                ledger: ledgerOf(turns),
                complete: read.value.complete,
                chains: read.value.chains,
              })
            : read
        }
        findings={findings}
        place={PLACE}
      />
    </IntlProvider>,
  );
}

describe("WaterfallPanel", () => {
  it("draws each turn's bar on the dearest turn's scale, and runs the total across them", async () => {
    const { container } = renderPanel([
      turn({ turn: 1, seq: "1", cost: usd("400000"), cacheHit: 0.87 }),
      turn({ turn: 2, seq: "10", cost: usd("800000"), cacheHit: 0.5 }),
      turn({ turn: 3, seq: "20", cost: usd("200000"), cacheHit: null }),
    ]);
    const bars = screen.getAllByTestId("waterfall-bar");
    expect(bars.map((bar) => bar.getAttribute("data-turn"))).toEqual([
      "1",
      "2",
      "3",
    ]);
    const heights = bars.map((bar) => Number(bar.getAttribute("height")));
    // The dearest turn fills the plot (264 less 36 and 44 of padding); the
    // others are drawn at their share of it.
    expect(heights[1]).toBe(184);
    expect(heights[0]).toBe(92);
    expect(heights[2]).toBe(46);
    const rows = screen.getAllByTestId("waterfall-row");
    expect(rows.map((row) => row.children[5]?.textContent)).toEqual([
      "$0.00 → $0.40",
      "$0.40 → $1.20",
      "$1.20 → $1.40",
    ]);
    expect(rows[1]).toHaveTextContent("T2");
    expect(rows[1]).toHaveTextContent("50%");
    expect(rows[2]?.children[3]).toHaveTextContent("not recorded");
    const svg = screen.getByRole("img", {
      name: "Cost by turn, accumulating to $1.40",
    });
    expect(svg).toHaveTextContent("87% cache");
    expect(svg).toHaveTextContent("cache not recorded");
    await expectNoAxe(container);
  });

  it("totals the rows and sets the total against the cost the run recorded", () => {
    renderPanel([
      turn({ turn: 1, seq: "1", steps: 3, frames: 7, cost: usd("400000") }),
      turn({ turn: 2, seq: "10", steps: 5, frames: 12, cost: usd("800000") }),
    ]);
    const total = screen.getByTestId("waterfall-total");
    expect(total.children[1]).toHaveTextContent("8");
    expect(total.children[2]).toHaveTextContent("19");
    expect(total.children[4]).toHaveTextContent("$1.20");
    // The run recorded more than its turns carry: both figures stand.
    expect(total.children[5]).toHaveTextContent("of $4.13 recorded");
    expect(screen.getByTestId("waterfall-panel")).toHaveTextContent(
      "2 turns · $4.13 gateway_observed",
    );
  });

  it("draws no bar for a turn whose cost was not recorded, and holds the running total (negative)", () => {
    renderPanel([
      turn({ turn: 1, seq: "1", cost: usd("400000") }),
      turn({ turn: 2, seq: "10", cost: null }),
      turn({ turn: 3, seq: "20", cost: usd("100000") }),
    ]);
    expect(screen.getAllByTestId("waterfall-bar")).toHaveLength(2);
    const unpriced = screen.getAllByTestId("waterfall-row")[1];
    if (unpriced === undefined) throw new Error("the second turn is listed");
    expect(unpriced.children[4]).toHaveTextContent("not recorded");
    expect(unpriced.children[5]).toHaveTextContent("$0.40 → $0.40");
    expect(within(unpriced).queryByText("$0.00")).toBeNull();
  });

  it("lists the turns without a chart when no turn carries a cost (negative)", () => {
    renderPanel([
      turn({ turn: 1, seq: "1", cost: null }),
      turn({ turn: 2, seq: "10", cost: null }),
    ]);
    expect(screen.getByTestId("waterfall-unpriced")).toHaveTextContent(
      "No turn in this run carries a cost",
    );
    expect(screen.queryByTestId("waterfall-bar")).toBeNull();
    expect(screen.getAllByTestId("waterfall-row")).toHaveLength(2);
    expect(screen.getByTestId("waterfall-total").children[4]).toHaveTextContent(
      "not recorded",
    );
  });

  it("says there is nothing to lay out when the run has no turn (negative)", () => {
    renderPanel([]);
    expect(screen.getByTestId("waterfall-empty")).toBeTruthy();
    expect(screen.queryByTestId("waterfall-total")).toBeNull();
  });

  it("names the per-turn read's failure rather than drawing an empty chart (negative)", () => {
    renderPanel([], {
      read: readError("frame_store_unreachable", 502),
    });
    expect(screen.getByTestId("waterfall-panel")).toHaveTextContent(
      "frame_store_unreachable",
    );
    expect(screen.queryByTestId("waterfall-empty")).toBeNull();
    // No turn count is claimed for a read that did not answer.
    expect(screen.getByTestId("waterfall-panel")).not.toHaveTextContent(
      "0 turns",
    );
  });

  it("counts the turns alone when the run recorded no cost, and says the total has nothing to be set against (negative)", () => {
    renderPanel([turn({ turn: 1, seq: "1", cost: usd("400000") })], {
      overrides: { cost: null },
    });
    expect(screen.getByTestId("waterfall-panel")).toHaveTextContent("1 turn");
    expect(screen.getByTestId("waterfall-panel")).not.toHaveTextContent(
      "1 turn ·",
    );
    expect(screen.getByTestId("waterfall-total").children[5]).toHaveTextContent(
      "not recorded",
    );
  });

  it("says a recorded cost's basis was not recorded rather than naming one (negative)", () => {
    renderPanel([turn({ turn: 1, seq: "1" })], {
      overrides: { cost: { micros: "4130000", currency: "USD", basis: null } },
    });
    expect(screen.getByTestId("waterfall-panel")).toHaveTextContent(
      "1 turn · $4.13 basis not recorded",
    );
  });

  it("draws no chart for a run priced in two currencies, and keeps each turn's own cost in the table (negative)", () => {
    // `ledgerOf` has no one total across currencies, so there is no scale,
    // and the line in the chart's place says so rather than claiming no turn
    // carries a cost.
    renderPanel([
      turn({ turn: 1, seq: "1", cost: usd("400000") }),
      turn({
        turn: 2,
        seq: "10",
        cost: { micros: "300000", currency: "EUR" },
      }),
    ]);
    expect(screen.queryByTestId("waterfall")).toBeNull();
    expect(screen.queryByTestId("waterfall-bar")).toBeNull();
    expect(screen.getByTestId("waterfall-unpriced")).toHaveTextContent(
      "more than one currency",
    );
    const [usdTurn, eurTurn] = screen.getAllByTestId("waterfall-row");
    if (usdTurn === undefined || eurTurn === undefined)
      throw new Error("two turns");
    expect(usdTurn.children[4]).toHaveTextContent("$0.40");
    expect(usdTurn.children[5]).toHaveTextContent("$0.00 → $0.40");
    expect(eurTurn.children[4]).toHaveTextContent("€0.30");
    // No one running figure spans the two currencies.
    expect(eurTurn.children[5]).toHaveTextContent("not recorded");
    expect(screen.getByTestId("waterfall-total").children[4]).toHaveTextContent(
      "not recorded",
    );
  });

  it("says the ledger shows the first turns when the run has more than one read carries (negative)", () => {
    renderPanel([turn({ turn: 1, seq: "1" }), turn({ turn: 2, seq: "10" })], {
      read: readOk({ turns: [], complete: false, chains: [] }),
    });
    expect(screen.getByTestId("waterfall-cut")).toHaveTextContent(
      "The run is longer than one read carries, so this shows its first 2 turns.",
    );
  });

  // #3370 (from #3415): the sum of the turns read is not the run's total, so
  // nothing beside it may call it the total.
  it("names the turns a cut ledger's sum covers wherever the sum is labelled (negative)", () => {
    renderPanel(
      [
        turn({ turn: 1, seq: "1", cost: usd("400000") }),
        turn({ turn: 2, seq: "10", cost: usd("800000") }),
      ],
      { read: readOk({ turns: [], complete: false, chains: [] }) },
    );
    const svg = screen.getByRole("img", {
      name: "Cost by turn over the first 2 turns, accumulating to $1.20",
    });
    // The chart's end label has little room, so it says the sum is partial;
    // the chart's name and the total row say which turns it covers.
    expect(svg).toHaveTextContent(/partial$/);
    expect(svg).not.toHaveTextContent(/total$/);
    expect(screen.getByTestId("waterfall-caption")).toHaveTextContent(
      "The dashed line is cost accumulating to $1.20 over the first 2 turns, not the whole run.",
    );
    const total = screen.getByTestId("waterfall-total");
    expect(total.children[0]).toHaveTextContent(/^first 2 turns$/);
    expect(total.children[4]).toHaveTextContent("$1.20");
  });

  it("labels the sum as the total when the ledger reached the run's last turn", () => {
    renderPanel([
      turn({ turn: 1, seq: "1", cost: usd("400000") }),
      turn({ turn: 2, seq: "10", cost: usd("800000") }),
    ]);
    expect(
      screen.getByRole("img", {
        name: "Cost by turn, accumulating to $1.20",
      }),
    ).toHaveTextContent(/total$/);
    expect(screen.getByTestId("waterfall-caption")).not.toHaveTextContent(
      "first",
    );
    expect(
      screen.getByTestId("waterfall-total").children[0],
    ).toHaveTextContent(/^total$/);
    expect(screen.queryByTestId("waterfall-cut")).toBeNull();
  });

  it("draws every turn with no cut note when the page's transcript stopped short (negative)", () => {
    renderPanel([turn({ turn: 1, seq: "1" })], {
      overrides: { whole: false },
    });
    expect(screen.getAllByTestId("waterfall-row")).toHaveLength(1);
    expect(screen.queryByTestId("waterfall-cut")).toBeNull();
  });
});

describe("WaterfallPanel's finding pins (#4001)", () => {
  const SUBAGENT = "0192d4a8-7c1e-7a00-8000-0000000000bb";
  const THREE = [
    turn({ turn: 1, seq: "1", cost: usd("400000") }),
    turn({ turn: 2, seq: "10", cost: usd("800000") }),
    turn({ turn: 3, seq: "20", cost: usd("200000") }),
  ];
  type Finding = RunFindings["findings"][number];
  const finding = (
    id: string,
    kind: Finding["kind"],
    citation: Finding["citation"],
  ): Finding => ({
    id,
    kind,
    subject: "Bash",
    saving: { micros: "60000", currency: "USD", basis: "estimated" },
    confidence: "high",
    citation,
  });
  const cited = (...findings: Finding[]) => readOk({ findings });
  const pinnedIn = (row: HTMLElement | undefined) =>
    row === undefined
      ? []
      : within(row)
          .queryAllByTestId("waterfall-pinned")
          .map((link) => link.getAttribute("data-finding"));

  it("pins a finding to the turn its root frame falls in, and names it in the Pinned column", async () => {
    const { container } = renderPanel(THREE, {
      findings: cited(
        finding("fnd_shell", "repeated_shell_commands", {
          runLevel: false,
          // Seq 14 falls in turn 2, which opens at seq 10.
          frames: [{ seq: "14" }],
          framesTotal: 1,
        }),
      ),
    });
    const pins = screen.getAllByTestId("waterfall-pin");
    expect(pins.map((pin) => pin.getAttribute("data-turn"))).toEqual(["2"]);
    const rows = screen.getAllByTestId("waterfall-row");
    expect(pinnedIn(rows[0])).toEqual([]);
    expect(pinnedIn(rows[1])).toEqual(["fnd_shell"]);
    expect(pinnedIn(rows[2])).toEqual([]);
    expect(rows[1]).toHaveTextContent("Repeated shell commands");
    await expectNoAxe(container);
  });

  it("links a pin to the finding's evidence over the Cost tab", () => {
    renderPanel(THREE, {
      findings: cited(
        finding("fnd_shell", "repeated_shell_commands", {
          runLevel: false,
          frames: [{ seq: "1" }],
          framesTotal: 1,
        }),
      ),
    });
    const link = screen.getByRole("link", { name: "Repeated shell commands" });
    expect(link.getAttribute("href")).toBe(
      "/acme/core-platform/runs/tse_7k2m9q?tab=cost&finding=fnd_shell",
    );
    expect(link.getAttribute("title")).toBe(
      "Repeated shell commands: $0.06 to save. Open its evidence.",
    );
  });

  it("places a subagent's frame at the turn its chain counts toward, not by its seq", () => {
    renderPanel(THREE, {
      read: readOk({
        turns: [],
        complete: true,
        chains: [{ sessionUuid: SUBAGENT, turn: 3 }],
      }),
      findings: cited(
        finding("fnd_dup", "duplicate_tool_calls", {
          runLevel: false,
          // Seq 2 on the root would be turn 1; on the subagent it is turn 3.
          frames: [{ seq: "2", sessionUuid: SUBAGENT }],
          framesTotal: 1,
        }),
      ),
    });
    expect(
      screen
        .getAllByTestId("waterfall-pin")
        .map((pin) => pin.getAttribute("data-turn")),
    ).toEqual(["3"]);
  });

  it("pins a finding citing two turns to both, and a run-level finding to the total row only", () => {
    renderPanel(THREE, {
      findings: cited(
        finding("fnd_shell", "repeated_shell_commands", {
          runLevel: false,
          frames: [{ seq: "3" }, { seq: "22" }],
          framesTotal: 2,
        }),
        finding("fnd_cache", "cache_writes_never_read", {
          runLevel: true,
          frames: [],
          framesTotal: 0,
        }),
      ),
    });
    const rows = screen.getAllByTestId("waterfall-row");
    expect(pinnedIn(rows[0])).toEqual(["fnd_shell"]);
    expect(pinnedIn(rows[2])).toEqual(["fnd_shell"]);
    expect(pinnedIn(screen.getByTestId("waterfall-total"))).toEqual([
      "fnd_cache",
    ]);
    // The run-level finding draws no diamond over any turn.
    expect(
      screen
        .getAllByTestId("waterfall-pin")
        .map((pin) => pin.getAttribute("data-turn")),
    ).toEqual(["1", "3"]);
  });

  it("pins a finding whose frames were not recorded to the total row, never a guessed turn (negative)", () => {
    renderPanel(THREE, {
      findings: cited(
        finding("fnd_old", "unpaged_results", {
          runLevel: false,
          frames: null,
          framesTotal: 4,
        }),
      ),
    });
    expect(screen.queryByTestId("waterfall-pin")).toBeNull();
    expect(pinnedIn(screen.getByTestId("waterfall-total"))).toEqual([
      "fnd_old",
    ]);
  });

  it("draws no pin and leaves the Pinned cells empty for a run no finding cites (negative)", () => {
    renderPanel(THREE);
    expect(screen.queryByTestId("waterfall-pin")).toBeNull();
    for (const row of screen.getAllByTestId("waterfall-row"))
      expect(row.lastElementChild?.textContent).toBe("");
    // The chart no longer says the pins are not recorded.
    expect(screen.getByTestId("waterfall-caption")).not.toHaveTextContent(
      "not recorded",
    );
  });

  it("says the pins are not recorded when the findings read fails (negative)", () => {
    renderPanel(THREE, {
      findings: readError("findings_unreachable", 502),
    });
    expect(screen.queryByTestId("waterfall-pin")).toBeNull();
    for (const row of screen.getAllByTestId("waterfall-row"))
      expect(row.lastElementChild).toHaveTextContent("not recorded");
    expect(screen.getByTestId("waterfall-panel")).toHaveTextContent(
      "findings_unreachable",
    );
  });
});
