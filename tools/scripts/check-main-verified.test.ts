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
  applyGrace,
  applySupersession,
  classifyRuns,
  graceRemainingMs,
  isEligibleRun,
  verdictOf,
} from "./check-main-verified.mjs";

/** A `pipeline.yml` run of the only kind that can answer for a main commit. */
const push = (over: Record<string, unknown> = {}) => ({
  event: "push",
  status: "completed",
  conclusion: "success",
  ...over,
});

describe("classifyRuns", () => {
  it("counts a concluded push run", () => {
    expect(classifyRuns([push()])).toBe("concluded");
    // A failure is still an answer — this guard asks whether anything looked,
    // not whether it liked what it saw.
    expect(classifyRuns([push({ conclusion: "failure" })])).toBe("concluded");
  });

  it("does NOT count a cancelled run", () => {
    // The witness. Eviction produces exactly this, so treating it as an answer
    // would make the guard blind to the incident it exists for.
    expect(classifyRuns([push({ conclusion: "cancelled" })])).toBe("none");
  });

  it("does NOT count a conclusion that proves nothing executed", () => {
    // The guard's own header names "a workflow that failed to start" as a cause
    // it catches, so that conclusion cannot also be its answer. `skipped` and
    // `action_required` are the same class: concluded, nothing run.
    expect(classifyRuns([push({ conclusion: "startup_failure" })])).toBe(
      "none",
    );
    expect(classifyRuns([push({ conclusion: "skipped" })])).toBe("none");
    expect(classifyRuns([push({ conclusion: "action_required" })])).toBe(
      "none",
    );
  });

  it("does NOT count a workflow_dispatch run", () => {
    // pipeline.yml skips checks, tests and e2e for a dispatch, and both deploy
    // jobs require a push to main, so such a run verified and deployed nothing.
    expect(classifyRuns([push({ event: "workflow_dispatch" })])).toBe("none");
    // Nor is one still going an answer on its way.
    expect(
      classifyRuns([
        push({
          event: "workflow_dispatch",
          status: "in_progress",
          conclusion: null,
        }),
      ]),
    ).toBe("none");
  });

  it("does not assume an unreported event is a push", () => {
    expect(classifyRuns([{ status: "completed", conclusion: "success" }])).toBe(
      "none",
    );
    expect(isEligibleRun(undefined)).toBe(false);
  });

  it("separates a run still in flight from no run at all", () => {
    expect(
      classifyRuns([push({ status: "in_progress", conclusion: null })]),
    ).toBe("in_flight");
    expect(classifyRuns([])).toBe("none");
    expect(classifyRuns(undefined)).toBe("none");
  });

  it("prefers a real conclusion over a cancelled sibling", () => {
    expect(classifyRuns([push({ conclusion: "cancelled" }), push()])).toBe(
      "concluded",
    );
  });

  it("prefers a real push conclusion over a dispatch sibling", () => {
    expect(classifyRuns([push({ event: "workflow_dispatch" }), push()])).toBe(
      "concluded",
    );
  });
});

describe("graceRemainingMs", () => {
  const GRACE = 10 * 60 * 1000;

  it("is zero when nothing is inside the grace", () => {
    expect(
      graceRemainingMs([{ sha: "a", state: "concluded", ageMs: 1 }], GRACE),
    ).toBe(0);
    expect(graceRemainingMs([], GRACE)).toBe(0);
  });

  it("waits out the youngest commit still inside the grace", () => {
    // Without this the guard suppresses the finding and does not look again
    // until the next push or the daily cron, so a run that never arrives goes
    // unreported for a day rather than for the ten minutes the grace promises.
    const wait = graceRemainingMs(
      [
        { sha: "a", state: "too_young", ageMs: GRACE - 60_000 },
        { sha: "b", state: "too_young", ageMs: GRACE - 120_000 },
      ],
      GRACE,
    );
    expect(wait).toBeGreaterThan(120_000);
    expect(wait).toBeLessThan(130_000);
  });

  it("ignores a commit whose age could not be read", () => {
    expect(graceRemainingMs([{ sha: "a", state: "too_young" }], GRACE)).toBe(0);
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

describe("applyGrace", () => {
  const MINUTE = 60 * 1000;
  const GRACE = 10 * MINUTE;
  const s = (state: string, ageMs?: number) => ({ sha: "abc", state, ageMs });

  it("spares a commit whose run has not appeared yet", () => {
    // The measured race on #3125: commit at 05:47:32Z, run created 05:47:35Z,
    // guard filed `no run at all` at 05:47:39Z — four seconds after the run
    // it could not see already existed.
    expect(applyGrace([s("none", 7 * 1000)], GRACE)[0]?.state).toBe(
      "too_young",
    );
  });

  it("judges a commit older than the grace normally", () => {
    // Past the grace a real gap is a real gap. Losing this would make the
    // guard permanently silent, which is worse than the noise it replaces.
    expect(applyGrace([s("none", 11 * MINUTE)], GRACE)[0]?.state).toBe("none");
  });

  it("treats the boundary itself as old enough to judge", () => {
    expect(applyGrace([s("none", GRACE)], GRACE)[0]?.state).toBe("none");
  });

  it("does not grace a commit whose age is unknown", () => {
    // An unparseable date is not a young commit. Guessing would silence the
    // guard on exactly the commits it could not date.
    expect(applyGrace([s("none", undefined)], GRACE)[0]?.state).toBe("none");
  });

  it("leaves every state but `none` alone", () => {
    // A commit with a visible run has an answer coming and needs no grace.
    for (const state of ["concluded", "in_flight", "superseded"]) {
      expect(applyGrace([s(state, 1000)], GRACE)[0]?.state).toBe(state);
    }
  });

  it("does not mutate its argument", () => {
    const states = [s("none", 1000)];
    applyGrace(states, GRACE);
    expect(states[0]?.state).toBe("none");
  });
});

describe("verdictOf with a too-young commit", () => {
  const s = (state: string) => ({ sha: "abc", state });

  it("is pending, so it neither announces nor closes", () => {
    expect(verdictOf([s("too_young")])).toBe("pending");
    expect(verdictOf([s("concluded"), s("too_young")])).toBe("pending");
  });

  it("does not soften a real gap sitting beside it", () => {
    expect(verdictOf([s("too_young"), s("none")])).toBe("unverified");
  });
});
