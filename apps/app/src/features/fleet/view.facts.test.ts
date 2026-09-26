// The paused and compacted row states in view.ts (#3835, ADR-190). These
// cases read the view.ts wiring in the run-rows lane's handoff. The tokens
// sort is proved on the whole page in row-facts.test.tsx.
import { describe, expect, it } from "vitest";
import { runRow } from "./fleet.builders";
import { chipRows, listRuns, rowState } from "./view";

const NONE = new Set<string>();

describe("rowState", () => {
  it("reads a live run whose last command paused it as paused", () => {
    expect(
      rowState(runRow({ status: "live", ingressPaused: true }), NONE),
    ).toBe("paused");
  });

  it("reads paused over parked, as the Run page does", () => {
    const run = runRow({
      id: "arun_both",
      status: "live",
      ingressPaused: true,
    });
    expect(rowState(run, new Set(["arun_both"]))).toBe("paused");
  });

  it("reads a sealed run whose recording was compacted as compacted", () => {
    expect(
      rowState(
        runRow({ status: "sealed", outcome: "completed", compacted: true }),
        NONE,
      ),
    ).toBe("compacted");
  });

  it.each([
    ["a resumed run", runRow({ status: "live", ingressPaused: false }), "live"],
    [
      "a sealed run not compacted",
      runRow({ status: "sealed", outcome: "completed", compacted: false }),
      "sealed",
    ],
    [
      "a halted run, whatever compaction says",
      runRow({ status: "halted", outcome: "cancelled", compacted: true }),
      "halted",
    ],
    [
      "a sealed run that was paused before it ended",
      runRow({ status: "sealed", outcome: "completed", ingressPaused: true }),
      "sealed",
    ],
  ] as const)("reads %s as its status (negative)", (_label, run, want) => {
    expect(rowState(run, NONE)).toBe(want);
  });
});

describe("chipRows", () => {
  const all = listRuns(
    [
      runRow({ id: "live", status: "live" }),
      runRow({ id: "paused", status: "live", ingressPaused: true }),
      runRow({ id: "parked", status: "live" }),
      runRow({ id: "sealed", status: "sealed", outcome: "completed" }),
      runRow({
        id: "compacted",
        status: "sealed",
        outcome: "completed",
        compacted: true,
      }),
      runRow({ id: "halted", status: "halted", outcome: "cancelled" }),
    ],
    new Set(["parked"]),
  );
  const ids = (chip: Parameters<typeof chipRows>[1]) =>
    chipRows(all, chip).map((row) => row.run.id);

  it("lists paused under parked and live, and compacted under sealed", () => {
    expect(ids("parked")).toEqual(["paused", "parked"]);
    expect(ids("live")).toEqual(["live", "paused", "parked"]);
    expect(ids("sealed")).toEqual(["sealed", "compacted"]);
    expect(ids("all")).toHaveLength(6);
  });
});
