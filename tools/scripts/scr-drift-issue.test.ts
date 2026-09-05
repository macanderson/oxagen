/**
 * The negative control is the whole point: an issue that merely *mentions* the
 * marker's words must not be treated as the drift issue. That is exactly what
 * happened in #2666, where a phrase search matched an unrelated issue and the
 * job overwrote its body.
 */
import { describe, expect, it } from "vitest";
import {
  MARKER,
  confirmMarkedIssues,
  decideDriftAction,
} from "./scr-drift-issue.mjs";

/** Bodies keyed by issue number, standing in for the issues API. */
function reader(bodies: Record<number, string | null>) {
  return async (n: number) => bodies[n] ?? null;
}

describe("confirmMarkedIssues", () => {
  it("keeps an issue whose body carries the marker", async () => {
    const got = await confirmMarkedIssues(
      [{ number: 1328 }],
      reader({ 1328: `${MARKER}\nThe corpus has drifted.` }),
    );
    expect(got).toEqual([1328]);
  });

  it("drops an issue that only mentions the marker's words", async () => {
    // The #2666 case. Search tokenises the marker, so prose like this matched
    // and the job replaced the issue's entire body.
    const got = await confirmMarkedIssues(
      [{ number: 1336 }],
      reader({
        1336: "Three repos call the DoD workflows on @main. See scr corpus drift.",
      }),
    );
    expect(got).toEqual([]);
  });

  it("keeps only the marked issue when search returns both", async () => {
    const got = await confirmMarkedIssues(
      [{ number: 1336 }, { number: 1328 }],
      reader({
        1336: "prose about scr corpus drift, no marker",
        1328: `${MARKER} real report`,
      }),
    );
    expect(got).toEqual([1328]);
  });

  it("survives an issue with no body at all", async () => {
    const got = await confirmMarkedIssues([{ number: 7 }], reader({ 7: null }));
    expect(got).toEqual([]);
  });

  it("treats no candidates as nothing confirmed", async () => {
    expect(await confirmMarkedIssues([], reader({}))).toEqual([]);
    expect(await confirmMarkedIssues(undefined, reader({}))).toEqual([]);
  });
});

describe("decideDriftAction", () => {
  it("updates the one marked issue", () => {
    expect(decideDriftAction([1328])).toEqual({
      action: "update",
      number: 1328,
    });
  });

  it("files a new issue when none is marked", () => {
    expect(decideDriftAction([])).toEqual({ action: "create" });
  });

  it("aborts rather than choosing between two marked issues", () => {
    // Picking one silently orphans the other — the same class of mistake as
    // acting on an unverified search hit.
    const got = decideDriftAction([1328, 1400]);
    expect(got.action).toBe("abort");
    expect(got.reason).toContain("1328");
    expect(got.reason).toContain("1400");
  });
});
