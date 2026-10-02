import { describe, expect, it } from "vitest";
import { similarStatements, type ComparedStatement } from "./conflicts";

const entry = (
  lineage: string,
  statement: string,
  kind = "business-rule",
  effect: string | null = null,
): ComparedStatement => ({ lineage, kind, effect, statement });

describe("similarStatements", () => {
  it("pairs two statements with the same words, whatever their case and punctuation", () => {
    const matches = similarStatements([
      entry("a", "Never push to main."),
      entry("b", "never push to MAIN"),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.opposite).toBe(false);
  });

  it("pairs long statements that share nine words in ten", () => {
    const matches = similarStatements([
      entry(
        "a",
        "Open every change as a pull request from a branch named for the work",
      ),
      entry(
        "b",
        "Open every change as a pull request from a branch named for the work today",
      ),
    ]);
    expect(matches.map((m) => [m.a.lineage, m.b.lineage])).toEqual([["a", "b"]]);
  });

  it("does not pair short statements that differ by one word (negative)", () => {
    expect(
      similarStatements([
        entry("a", "Use tabs for indentation"),
        entry("b", "Use spaces for indentation"),
      ]),
    ).toEqual([]);
  });

  it("marks two constraints on the same statement with opposite effects", () => {
    const [match] = similarStatements([
      entry("a", "Deploy on Fridays", "constraint", "forbid"),
      entry("b", "Deploy on Fridays", "constraint", "require"),
    ]);
    expect(match?.opposite).toBe(true);
  });

  it("does not mark a constraint and a rule as opposite (negative)", () => {
    const [match] = similarStatements([
      entry("a", "Deploy on Fridays", "constraint", "forbid"),
      entry("b", "Deploy on Fridays", "business-rule", null),
    ]);
    expect(match?.opposite).toBe(false);
  });
});
