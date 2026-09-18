// @vitest-environment jsdom
// The run waterfall (spec §12.9): `buildBars`, the pure join between the
// `turns` and `steps` transcript reads, and the `Waterfall` component that
// draws it.
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
import { buildBars, Waterfall } from "./waterfall";

afterEach(cleanup);

const usd = (micros: string) => ({
  micros,
  currency: "USD" as const,
  basis: "gateway_observed" as const,
});

describe("buildBars", () => {
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
    const { bars } = buildBars(
      [turnA, turnB],
      [stepInA1, stepInA2, stepInB, stepOutside],
    );
    expect(bars).toHaveLength(2);
    expect(barAt(bars, 0).steps.map((s) => s.label)).toEqual(["a1", "a2"]);
    expect(barAt(bars, 1).steps.map((s) => s.label)).toEqual(["b1"]);
    // The step outside every range lands in no bar at all.
    const assigned = bars.flatMap((bar) => bar.steps.map((s) => s.label));
    expect(assigned).not.toContain("orphan");
  });

  it("takes the run total from the last turn's cumulativeCost and tiles the bars left to right", () => {
    const turnA = transcriptEntry({
      seq: "1",
      endSeq: "5",
      cost: usd("1000000"),
      cumulativeCost: usd("1000000"),
    });
    const turnB = transcriptEntry({
      seq: "6",
      endSeq: "10",
      cost: usd("3000000"),
      cumulativeCost: usd("4000000"),
    });
    const { bars, total } = buildBars([turnA, turnB], []);
    expect(total).toEqual(usd("4000000"));
    expect(barAt(bars, 0).offset).toBe(0);
    expect(barAt(bars, 0).width).toBeCloseTo(0.25);
    expect(barAt(bars, 1).width).toBeCloseTo(0.75);
    // The second bar starts exactly where the first bar's own share ends.
    expect(barAt(bars, 1).offset).toBeCloseTo(
      barAt(bars, 0).offset + (barAt(bars, 0).width ?? 0),
    );
  });

  it("gives a turn with a null cost a null width (negative)", () => {
    const turnA = transcriptEntry({
      seq: "1",
      endSeq: "5",
      cost: null,
      cumulativeCost: null,
    });
    const turnB = transcriptEntry({
      seq: "6",
      endSeq: "10",
      cost: usd("2000000"),
      cumulativeCost: usd("2000000"),
    });
    const { bars } = buildBars([turnA, turnB], []);
    expect(barAt(bars, 0).width).toBeNull();
    expect(barAt(bars, 1).width).toBeCloseTo(1);
  });
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

/** One bar by position, refusing rather than reading past the end. */
function barAt(bars: ReturnType<typeof buildBars>["bars"], index: number) {
  const bar = bars[index];
  if (bar === undefined) throw new Error(`no bar at ${String(index)}`);
  return bar;
}

describe("Waterfall", () => {
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
    expect(
      within(unpricedBar).queryByTestId("waterfall-fill"),
    ).toBeNull();
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
      readOk(
        runTranscript({ entries: [transcriptEntry()], complete: false }),
      ),
      readOk(runTranscript({ entries: [] })),
    );
    expect(screen.getByTestId("waterfall-cut")).toHaveTextContent(
      "The run has more turns than one read carries, so this stops short of the end.",
    );
  });

  it("renders the ReadFailure treatment when the turns read is refused", () => {
    renderWaterfall(
      readError("frame_store_unreachable", 502),
      readOk(runTranscript({ entries: [] })),
    );
    expect(screen.getByText(/Run waterfall could not be loaded/)).toHaveTextContent(
      "Run waterfall could not be loaded: the control plane answered frame_store_unreachable. Nothing was changed, and runs kept recording.",
    );
  });

  it("renders the ReadFailure treatment when the steps read is refused", () => {
    renderWaterfall(
      readOk(runTranscript({ entries: [transcriptEntry()] })),
      readError("frame_store_unreachable", 502),
    );
    expect(screen.getByText(/Run waterfall could not be loaded/)).toHaveTextContent(
      "Run waterfall could not be loaded: the control plane answered frame_store_unreachable. Nothing was changed, and runs kept recording.",
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
