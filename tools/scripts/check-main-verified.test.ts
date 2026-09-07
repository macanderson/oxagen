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
import { classifyRuns, verdictOf } from "./check-main-verified.mjs";

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
