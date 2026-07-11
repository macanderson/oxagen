import { describe, expect, it } from "vitest";
import { bisectTurns } from "./bisect.js";

/** Probe over a known dooming turn: good strictly before `firstBad`. */
function probeWithFirstBad(firstBad: number, calls: number[]) {
  return async (turn: number): Promise<boolean> => {
    calls.push(turn);
    return turn < firstBad;
  };
}

describe("bisectTurns", () => {
  it("finds the dooming turn in the middle of the range", async () => {
    const calls: number[] = [];
    const result = await bisectTurns({
      goodTurn: 0,
      badTurn: 10,
      probe: probeWithFirstBad(7, calls),
    });
    expect(result.firstBadTurn).toBe(7);
    expect(result.probes.map((p) => p.turn)).toEqual(calls);
  });

  it("handles the first turn being the dooming one", async () => {
    const calls: number[] = [];
    const result = await bisectTurns({
      goodTurn: 0,
      badTurn: 10,
      probe: probeWithFirstBad(1, calls),
    });
    expect(result.firstBadTurn).toBe(1);
  });

  it("handles the last turn being the dooming one", async () => {
    const calls: number[] = [];
    const result = await bisectTurns({
      goodTurn: 0,
      badTurn: 10,
      probe: probeWithFirstBad(10, calls),
    });
    expect(result.firstBadTurn).toBe(10);
  });

  it("probes O(log n) times", async () => {
    const calls: number[] = [];
    await bisectTurns({
      goodTurn: 0,
      badTurn: 1024,
      probe: probeWithFirstBad(700, calls),
    });
    expect(calls.length).toBeLessThanOrEqual(10);
  });

  it("needs no probes for an adjacent good/bad pair", async () => {
    const result = await bisectTurns({
      goodTurn: 3,
      badTurn: 4,
      probe: async () => {
        throw new Error("must not probe");
      },
    });
    expect(result.firstBadTurn).toBe(4);
    expect(result.probes).toEqual([]);
  });

  it("rejects an invalid range", async () => {
    await expect(
      bisectTurns({ goodTurn: 5, badTurn: 5, probe: async () => true }),
    ).rejects.toThrow(/goodTurn < badTurn/);
  });
});
