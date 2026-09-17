/**
 * The three states this guard has to tell apart (#2730).
 *
 * Two of them look identical to every other signal in CI: a commit with no run
 * and a commit whose run is still going both report nothing, and both used to
 * read as fine. The incident was made of the first, and hidden by the fact that
 * an evicted run concludes `cancelled` — which is why a cancelled run is not a
 * conclusion here.
 */
import { describe, expect, it } from "vitest";
import {
  applySupersession,
  classifyRuns,
  verdictOf,
} from "./check-main-verified.mjs";

describe("classifyRuns", () => {
  it("counts a concluded run", () => {
    expect(classifyRuns([{ status: "completed", conclusion: "success" }])).toBe(
      "concluded",
    );
    // A failure is still an answer — this guard asks whether anything looked,
    // not whether it liked what it saw.
    expect(classifyRuns([{ status: "completed", conclusion: "failure" }])).toBe(
      "concluded",
    );
  });

  it("does NOT count a cancelled run", () => {
    // The witness. Eviction produces exactly this, so treating it as an answer
    // would make the guard blind to the incident it exists for.
    expect(
      classifyRuns([{ status: "completed", conclusion: "cancelled" }]),
    ).toBe("none");
  });

  it("separates a run still in flight from no run at all", () => {
    expect(classifyRuns([{ status: "in_progress", conclusion: null }])).toBe(
      "in_flight",
    );
    expect(classifyRuns([])).toBe("none");
    expect(classifyRuns(undefined)).toBe("none");
  });

  it("prefers a real conclusion over a cancelled sibling", () => {
    expect(
      classifyRuns([
        { status: "completed", conclusion: "cancelled" },
        { status: "completed", conclusion: "success" },
      ]),
    ).toBe("concluded");
  });
});

describe("verdictOf", () => {
  const s = (state: string) => ({ sha: "abc", state });

  it("is verified only when every commit has an answer", () => {
    expect(verdictOf([s("concluded"), s("concluded")])).toBe("verified");
  });

  it("is unverified when any commit has no run", () => {
    expect(verdictOf([s("concluded"), s("none")])).toBe("unverified");
  });

  it("is pending when the only gap is still running", () => {
    // Pending must not close an open issue: a recovery is claimed off an
    // answer, never off the absence of one.
    expect(verdictOf([s("concluded"), s("in_flight")])).toBe("pending");
  });

  it("prefers unverified over pending when both are present", () => {
    // A commit with no run at all is the finding; one still running is not a
    // reason to soften it.
    expect(verdictOf([s("in_flight"), s("none")])).toBe("unverified");
  });
});

/**
 * The guard is a `.mjs` with no declaration file, so everything it returns
 * arrives as `any`. Naming the shape here is what makes these assertions
 * actually check something under `noImplicitAny`.
 */
type CommitState = { sha: string; state: string };

describe("applySupersession", () => {
  const s = (sha: string, state: string): CommitState => ({ sha, state });

  it("leaves a window with no gaps alone", () => {
    const states = [s("head", "concluded"), s("older", "concluded")];
    expect(applySupersession(states)).toEqual(states);
  });

  it("supersedes a gap that a later commit answered", () => {
    // The #3125 shape: HEAD ran, an older commit never did and never will.
    expect(
      applySupersession([s("head", "concluded"), s("d3e5ebef", "none")]),
    ).toEqual([s("head", "concluded"), s("d3e5ebef", "superseded")]);
  });

  it("never supersedes HEAD", () => {
    // Nothing is later than HEAD, so a gap there is the live blindness case
    // and must stay the finding however healthy the history below it looks.
    expect(
      applySupersession([s("head", "none"), s("older", "concluded")]),
    ).toEqual([s("head", "none"), s("older", "concluded")]);
  });

  it("does not let an in-flight run supersede anything", () => {
    // Same reason `pending` closes nothing: a run still going is not an answer.
    expect(
      applySupersession([s("head", "in_flight"), s("older", "none")]),
    ).toEqual([s("head", "in_flight"), s("older", "none")]);
  });

  it("supersedes every gap below the newest conclusion, not just the next one", () => {
    // The #2730 shape after recovery: a burst of unrun commits, then one that
    // ran. All of them are history nothing can answer.
    expect(
      applySupersession([
        s("a", "concluded"),
        s("b", "none"),
        s("c", "none"),
        s("d", "none"),
      ]).map((x: CommitState) => x.state),
    ).toEqual(["concluded", "superseded", "superseded", "superseded"]);
  });

  it("does not supersede a gap that is newer than the only conclusion", () => {
    // Ordering is newest-first, so index 2 concluding says nothing about the
    // gap at index 1 above it. Getting this backwards would silence the guard.
    expect(
      applySupersession([
        s("head", "concluded"),
        s("gap", "none"),
        s("old", "concluded"),
      ]).map((x: CommitState) => x.state),
    ).toEqual(["concluded", "superseded", "concluded"]);
  });

  it("does not mutate its argument", () => {
    const states = [s("head", "concluded"), s("older", "none")];
    applySupersession(states);
    expect(states[1]?.state).toBe("none");
  });
});

describe("verdictOf with supersession applied", () => {
  const s = (state: string) => ({ sha: "abc", state });

  it("is verified when the only gaps are superseded", () => {
    // This is what finally closes an open main-unverified issue instead of
    // re-commenting on it forever (#3125).
    expect(verdictOf([s("concluded"), s("superseded")])).toBe("verified");
  });

  it("still reports unverified when a real gap remains beside a superseded one", () => {
    expect(verdictOf([s("none"), s("concluded"), s("superseded")])).toBe(
      "unverified",
    );
  });

  it("is pending when a superseded gap sits beside a run still going", () => {
    expect(verdictOf([s("in_flight"), s("superseded")])).toBe("pending");
  });
});
