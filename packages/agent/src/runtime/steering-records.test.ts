/**
 * The rendering half of #2592: what a workspace's published records look like
 * once they reach a turn. The query half is exercised by the handler tests;
 * this is the part that has to be deterministic.
 */
import { describe, expect, it } from "vitest";
import { formatSteering, type SteeringRecord } from "./steering-records";

const rec = (over: Partial<SteeringRecord> = {}): SteeringRecord => ({
  slug: "no-console",
  title: "No console logging",
  body: "Use the logger, never console.log.",
  ...over,
});

describe("formatSteering (#2592)", () => {
  it("returns nothing at all for a workspace that published nothing", () => {
    // Not an empty heading, not a whitespace string: the caller skips the
    // message entirely on "", which is what keeps the transcript's shape
    // unchanged for a surface with no records.
    expect(formatSteering([])).toBe("");
  });

  it("says these are policy for the turn, not background reading", () => {
    const out = formatSteering([rec()]);
    expect(out).toContain("policy for this turn");
  });

  it("carries each record's title, slug and body", () => {
    const out = formatSteering([rec()]);
    expect(out).toContain("No console logging");
    expect(out).toContain("no-console");
    expect(out).toContain("Use the logger, never console.log.");
  });

  it("says what to do when the instruction contradicts a record", () => {
    // Otherwise a record and a user asking for the opposite is an unstated
    // conflict the model resolves silently.
    expect(formatSteering([rec()])).toContain("directly contradicts");
  });

  it("is byte-identical for the same records, so a transcript diff means a policy change", () => {
    const a = formatSteering([rec({ slug: "a" }), rec({ slug: "b" })]);
    const b = formatSteering([rec({ slug: "a" }), rec({ slug: "b" })]);
    expect(a).toBe(b);
  });

  it("renders records in the order it is given, which the loader sorts by slug", () => {
    const out = formatSteering([
      rec({ slug: "a", title: "Alpha" }),
      rec({ slug: "z", title: "Zulu" }),
    ]);
    expect(out.indexOf("Alpha")).toBeLessThan(out.indexOf("Zulu"));
  });

  it("trims a record body so trailing whitespace cannot shift the text", () => {
    expect(formatSteering([rec({ body: "  rule  \n\n" })])).toContain("rule");
    expect(formatSteering([rec({ body: "rule" })])).toBe(
      formatSteering([rec({ body: "rule\n\n" })]),
    );
  });
});
