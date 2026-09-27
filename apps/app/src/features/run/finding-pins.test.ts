// Where the Cost tab pins a finding (#4001): a root frame by the turns' opening
// seqs, compared as digits and never as floats, and a subagent frame by the
// turn its chain counts toward.
import { describe, expect, it } from "vitest";
import type { RunFindings } from "@/data/contracts/run";
import { pinsOf } from "./finding-pins";

type Finding = RunFindings["findings"][number];

const finding = (id: string, citation: Finding["citation"]): Finding => ({
  id,
  kind: "duplicate_tool_calls",
  subject: "acme.core.cc",
  saving: { micros: "20000", currency: "USD", basis: "estimated" },
  confidence: "medium",
  citation,
});

const frames = (...seqs: string[]): Finding["citation"] => ({
  runLevel: false,
  frames: seqs.map((seq) => ({ seq })),
  framesTotal: seqs.length,
});

const ids = (list: readonly Finding[] | undefined) =>
  (list ?? []).map((f) => f.id);

describe("pinsOf", () => {
  it("orders seqs as numbers, so seq 9 falls before a turn opening at 10", () => {
    const pins = pinsOf(
      [
        { turn: 1, seq: "2" },
        { turn: 2, seq: "10" },
      ],
      [],
      [finding("fnd_a", frames("9")), finding("fnd_b", frames("10"))],
    );
    expect(ids(pins.byTurn.get(1))).toEqual(["fnd_a"]);
    expect(ids(pins.byTurn.get(2))).toEqual(["fnd_b"]);
  });

  it("compares seqs past what a float holds exactly", () => {
    const pins = pinsOf(
      [
        { turn: 1, seq: "9007199254740992" },
        { turn: 2, seq: "9007199254740993" },
      ],
      [],
      [finding("fnd_a", frames("9007199254740992"))],
    );
    expect(ids(pins.byTurn.get(1))).toEqual(["fnd_a"]);
    expect(pins.byTurn.has(2)).toBe(false);
  });

  it("pins a frame recorded before the first turn opened to the run, not to a turn (negative)", () => {
    const pins = pinsOf(
      [{ turn: 1, seq: "5" }],
      [],
      [finding("fnd_a", frames("3"))],
    );
    expect(pins.byTurn.size).toBe(0);
    expect(ids(pins.run)).toEqual(["fnd_a"]);
  });

  it("pins a subagent frame whose chain counts toward no drawn turn to the run (negative)", () => {
    const pins = pinsOf(
      [{ turn: 1, seq: "1" }],
      [{ sessionUuid: "0192d4a8-7c1e-7a00-8000-0000000000c1", turn: 9 }],
      [
        finding("fnd_a", {
          runLevel: false,
          frames: [
            { seq: "4", sessionUuid: "0192d4a8-7c1e-7a00-8000-0000000000c1" },
            { seq: "4", sessionUuid: "0192d4a8-7c1e-7a00-8000-0000000000c9" },
          ],
          framesTotal: 2,
        }),
      ],
    );
    expect(pins.byTurn.size).toBe(0);
    expect(ids(pins.run)).toEqual(["fnd_a"]);
  });

  it("names a finding once per turn however many of its frames fall there", () => {
    const pins = pinsOf(
      [{ turn: 1, seq: "1" }],
      [],
      [finding("fnd_a", frames("2", "3", "4"))],
    );
    expect(ids(pins.byTurn.get(1))).toEqual(["fnd_a"]);
  });
});
