// @vitest-environment jsdom
// The run waterfall (spec §12.9): the `Waterfall` component's join between
// the `turns` and `steps` transcript reads, and the bars it draws from them.
//
// The join and the tiling are internal to `waterfall.tsx` (`buildBars` is not
// exported: nothing outside the module consumes it, and a production-only
// export knip would flag as unused is not a public surface worth carrying).
// These are proven the way the component's own consumers see them: through
// the rendered bar, its steps, and its fill's width and offset.
//
// The rule these hold is the file's own: a turn whose cost the recording did
// not carry draws no bar, because a zero-width bar would read as "this turn
// cost nothing," a measurement nobody made.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { runTranscript, transcriptEntry } from "./run.builders";
import { Waterfall } from "./waterfall";

afterEach(cleanup);

const usd = (micros: string) => ({
  micros,
  currency: "USD" as const,
  basis: "gateway_observed" as const,
});

function renderWaterfall(
  turns: Parameters<typeof Waterfall>[0]["turns"],
  steps: Parameters<typeof Waterfall>[0]["steps"],
) {
  return render(
    <IntlProvider>
      <Waterfall turns={turns} steps={steps} />
    </IntlProvider>,
  );
}

describe("Waterfall", () => {
  it("joins each step to the turn whose [seq, endSeq] range holds the step's seq", () => {
    const turnA = transcriptEntry({
      seq: "1",
      endSeq: "5",
      label: "turn-a",
      cost: usd("1000000"),
      cumulativeCost: usd("1000000"),
    });
    const turnB = transcriptEntry({
      seq: "6",
      endSeq: "10",
      label: "turn-b",
      cost: usd("3000000"),
      cumulativeCost: usd("4000000"),
    });
    const stepInA1 = transcriptEntry({ seq: "2", endSeq: "2", label: "a1" });
    const stepInA2 = transcriptEntry({ seq: "5", endSeq: "5", label: "a2" });
    const stepInB = transcriptEntry({ seq: "8", endSeq: "8", label: "b1" });
    const stepOutside = transcriptEntry({
      seq: "20",
      endSeq: "20",
      label: "orphan",
    });
    renderWaterfall(
      readOk(runTranscript({ entries: [turnA, turnB] })),
      readOk(
        runTranscript({
          entries: [stepInA1, stepInA2, stepInB, stepOutside],
        }),
      ),
    );
    const bars = screen.getAllByTestId("waterfall-bar");
    expect(bars).toHaveLength(2);
    const [barA, barB] = bars;
    if (barA === undefined || barB === undefined) {
      throw new Error("both bars are drawn");
    }
    expect(
      within(barA)
        .getAllByTestId("waterfall-step")
        .map((step) => step.getAttribute("title")),
    ).toEqual(["a1", "a2"]);
    expect(
      within(barB)
        .getAllByTestId("waterfall-step")
        .map((step) => step.getAttribute("title")),
    ).toEqual(["b1"]);
    // The step outside every range lands in no bar at all.
    expect(screen.queryByTitle("orphan")).toBeNull();
  });

  it("takes the run total from the last turn's cumulativeCost and tiles the bars left to right", () => {
    const turnA = transcriptEntry({
      seq: "1",
      endSeq: "5",
      label: "turn-a",
      cost: usd("1000000"),
      cumulativeCost: usd("1000000"),
    });
    const turnB = transcriptEntry({
      seq: "6",
      endSeq: "10",
      label: "turn-b",
      cost: usd("3000000"),
      cumulativeCost: usd("4000000"),
    });
    renderWaterfall(
      readOk(runTranscript({ entries: [turnA, turnB] })),
      readOk(runTranscript({ entries: [] })),
    );
    const bars = screen.getAllByTestId("waterfall-bar");
    const [barA, barB] = bars;
    if (barA === undefined || barB === undefined) {
      throw new Error("both bars are drawn");
    }
    const fillA = within(barA).getByTestId("waterfall-fill");
    const fillB = within(barB).getByTestId("waterfall-fill");
    // The run total (4,000,000 micros) is the last turn's cumulativeCost:
    // turn A is a quarter of it, turn B the remaining three quarters, and
    // the second bar starts exactly where the first bar's own share ends.
    expect(fillA.style.marginInlineStart).toBe("0%");
    expect(fillA.style.width).toBe("25%");
    expect(fillB.style.marginInlineStart).toBe("25%");
    expect(fillB.style.width).toBe("75%");
    const totalLine = screen.getByText(/over the run/);
    expect(within(totalLine).getByTestId("money")).toHaveTextContent(/4/);
  });

  it("renders one waterfall-bar per turn, the running total beside each, and the run total line above", () => {
    const turnA = transcriptEntry({
      seq: "1",
      endSeq: "5",
      label: "turn-a",
      cost: usd("1000000"),
      cumulativeCost: usd("1000000"),
    });
    const turnB = transcriptEntry({
      seq: "6",
      endSeq: "10",
      label: "turn-b",
      cost: usd("3000000"),
      cumulativeCost: usd("4000000"),
    });
    renderWaterfall(
      readOk(runTranscript({ entries: [turnA, turnB] })),
      readOk(runTranscript({ entries: [] })),
    );
    const bars = screen.getAllByTestId("waterfall-bar");
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(within(bar).getByText(/running total/)).toBeInTheDocument();
      // Every money figure, not just the words beside it: `t.rich` drops a
      // value passed as a function when the message carries a plain `{cost}`
      // placeholder, and the row still reads "running total" without it.
      expect(within(bar).getAllByTestId("money").length).toBeGreaterThan(1);
    }
    const totalLine = screen.getByText(/over the run/);
    expect(within(totalLine).getByTestId("money")).toHaveTextContent(/\d/);
    const list = screen.getByTestId("waterfall");
    expect(
      totalLine.compareDocumentPosition(list) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("draws no fill and says the cost was not recorded for a turn with a null cost (negative)", () => {
    const turnA = transcriptEntry({
      seq: "1",
      endSeq: "5",
      label: "turn-a",
      cost: null,
      cumulativeCost: null,
    });
    const turnB = transcriptEntry({
      seq: "6",
      endSeq: "10",
      label: "turn-b",
      cost: usd("2000000"),
      cumulativeCost: usd("2000000"),
    });
    renderWaterfall(
      readOk(runTranscript({ entries: [turnA, turnB] })),
      readOk(runTranscript({ entries: [] })),
    );
    const bars = screen.getAllByTestId("waterfall-bar");
    const unpricedBar = bars[0];
    if (unpricedBar === undefined) throw new Error("the first bar is drawn");
    expect(
      within(unpricedBar).getByText("this turn's cost was not recorded"),
    ).toBeInTheDocument();
    expect(within(unpricedBar).queryByTestId("waterfall-fill")).toBeNull();
    const pricedBar = bars[1];
    if (pricedBar === undefined) throw new Error("the second bar is drawn");
    expect(within(pricedBar).getByTestId("waterfall-fill")).toBeInTheDocument();
  });

  it("renders waterfall-unpriced when every turn is unpriced, rather than bars with no scale", () => {
    const turnA = transcriptEntry({
      seq: "1",
      endSeq: "5",
      cost: null,
      cumulativeCost: null,
    });
    renderWaterfall(
      readOk(runTranscript({ entries: [turnA] })),
      readOk(runTranscript({ entries: [] })),
    );
    expect(screen.getByTestId("waterfall-unpriced")).toHaveTextContent(
      "No turn in this run carries a cost, so the bars have no scale to sit against. The turns and their steps are listed as recorded.",
    );
    expect(screen.queryByText(/over the run/)).toBeNull();
  });

  it("renders waterfall-empty when there are no turns (negative)", () => {
    renderWaterfall(
      readOk(runTranscript({ entries: [] })),
      readOk(runTranscript({ entries: [] })),
    );
    expect(screen.getByTestId("waterfall-empty")).toHaveTextContent(
      "This run has no turn the recording could fold, so there is nothing to lay out.",
    );
    expect(screen.queryByTestId("waterfall")).toBeNull();
  });

  it("renders waterfall-cut when the turns read did not carry the whole run", () => {
    renderWaterfall(
      readOk(runTranscript({ entries: [transcriptEntry()], complete: false })),
      readOk(runTranscript({ entries: [] })),
    );
    expect(screen.getByTestId("waterfall-cut")).toHaveTextContent(
      "This stops short of the end of the run: the run is still recording, or it has more turns and steps than these reads carry.",
    );
  });

  it("says it is partial when the steps read has a page past the last one read", () => {
    // `complete` means the read's frame cap; another page waiting is a
    // cursor. The waterfall used to read the first page of steps and never
    // said its later turns were drawn without theirs.
    renderWaterfall(
      readOk(runTranscript({ entries: [transcriptEntry()] })),
      readOk(runTranscript({ entries: [], cursor: "dDo5" })),
    );
    expect(screen.getByTestId("waterfall-cut")).toBeInTheDocument();
  });

  it("puts a subagent's step in the turn it was recorded in, whatever its own seq", () => {
    // A subagent's chain is numbered from 0 like the run's, so its seq falls
    // in whichever turn's range it happens to; its `turn` says where it ran.
    const turnA = transcriptEntry({
      seq: "0",
      endSeq: "5",
      turn: 1,
      label: "turn-a",
      cost: usd("1000000"),
      cumulativeCost: usd("1000000"),
    });
    const turnB = transcriptEntry({
      seq: "6",
      endSeq: "10",
      turn: 2,
      label: "turn-b",
      cost: usd("1000000"),
      cumulativeCost: usd("2000000"),
    });
    const sub = transcriptEntry({
      seq: "3",
      endSeq: "3",
      turn: 2,
      label: "sub",
      subagent: {
        chainRef: "0192d4a8-7c1e-7a00-8000-0000000000c1",
        type: null,
      },
    });
    renderWaterfall(
      readOk(runTranscript({ entries: [turnA, turnB] })),
      readOk(runTranscript({ entries: [sub] })),
    );
    const [barA, barB] = screen.getAllByTestId("waterfall-bar");
    expect(barA).toHaveTextContent("0 steps");
    expect(barB).toHaveTextContent("1 steps");
  });

  it("renders the ReadFailure treatment when the turns read is refused", () => {
    renderWaterfall(
      readError("frame_store_unreachable", 502),
      readOk(runTranscript({ entries: [] })),
    );
    expect(screen.getByText(/Waterfall could not be loaded/)).toHaveTextContent(
      "Waterfall could not be loaded: the control plane answered frame_store_unreachable. Nothing was changed, and runs kept recording.",
    );
  });

  it("renders the ReadFailure treatment when the steps read is refused", () => {
    renderWaterfall(
      readOk(runTranscript({ entries: [transcriptEntry()] })),
      readError("frame_store_unreachable", 502),
    );
    expect(screen.getByText(/Waterfall could not be loaded/)).toHaveTextContent(
      "Waterfall could not be loaded: the control plane answered frame_store_unreachable. Nothing was changed, and runs kept recording.",
    );
  });

  it("lays the turns out in the spec's ledger, with a total row that is the last running total", () => {
    const turnA = transcriptEntry({
      seq: "1",
      endSeq: "5",
      label: "turn-a",
      frames: 5,
      usage: {
        inputUncached: 100,
        cacheRead: 300,
        cacheWrite: 0,
        output: 20,
        reasoning: 0,
      },
      cost: usd("1000000"),
      cumulativeCost: usd("1000000"),
    });
    const turnB = transcriptEntry({
      seq: "6",
      endSeq: "10",
      label: "turn-b",
      frames: 5,
      usage: null,
      cost: usd("3000000"),
      cumulativeCost: usd("4000000"),
    });
    renderWaterfall(
      readOk(runTranscript({ entries: [turnA, turnB] })),
      readOk(runTranscript({ entries: [] })),
    );
    const table = screen.getByRole("table", { name: "Turns" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual([
      "Turn",
      "Steps",
      "Frames",
      "Cache hit",
      "Cost",
      "Running total",
      "Pinned",
    ]);
    const rows = within(table).getAllByRole("row").slice(1);
    // cache_read ÷ (input_uncached + cache_read) over the turn's own usage.
    expect(rows[0]).toHaveTextContent("75%");
    // A turn with no usage says its cache hit was not recorded.
    expect(rows[1]).toHaveTextContent("not recorded");
    expect(screen.getByTestId("waterfall-total")).toHaveTextContent(
      "of $4.00 recorded",
    );
  });

  it("passes an axe check on the loaded render", async () => {
    const turnA = transcriptEntry({
      seq: "1",
      endSeq: "5",
      label: "turn-a",
      cost: usd("1000000"),
      cumulativeCost: usd("1000000"),
    });
    const { container } = renderWaterfall(
      readOk(runTranscript({ entries: [turnA] })),
      readOk(runTranscript({ entries: [] })),
    );
    await expectNoAxe(container);
  });
});
