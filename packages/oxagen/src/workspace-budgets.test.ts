import { describe, expect, it } from "vitest";
import {
  dailyBudgetUsdOf,
  laneBudgetUsd,
  NO_DAILY_BUDGET,
  SPEND_LANES,
} from "./workspace-budgets";

// #5426: the budgets live in the workspace's settings bag. A value that
// cannot be read is no limit, so a malformed setting never refuses a call.
describe("dailyBudgetUsdOf", () => {
  it("reads each lane's budget, and null for a lane with none", () => {
    expect(
      dailyBudgetUsdOf({
        runEnrichmentEnabled: true,
        dailyBudgetUsd: { runEnrichment: 2, assistant: null, work: 0.5 },
      }),
    ).toEqual({ runEnrichment: 2, assistant: null, work: 0.5 });
  });

  it("reads a missing bag, a non-object bag, and a malformed value as no limit", () => {
    expect(dailyBudgetUsdOf(undefined)).toEqual(NO_DAILY_BUDGET);
    expect(dailyBudgetUsdOf(null)).toEqual(NO_DAILY_BUDGET);
    expect(dailyBudgetUsdOf([])).toEqual(NO_DAILY_BUDGET);
    expect(dailyBudgetUsdOf({ dailyBudgetUsd: "2" })).toEqual(NO_DAILY_BUDGET);
    expect(dailyBudgetUsdOf({ dailyBudgetUsd: [1, 2, 3] })).toEqual(
      NO_DAILY_BUDGET,
    );
    expect(
      dailyBudgetUsdOf({
        dailyBudgetUsd: {
          runEnrichment: "2",
          assistant: -1,
          work: Number.POSITIVE_INFINITY,
        },
      }),
    ).toEqual(NO_DAILY_BUDGET);
  });

  it("keeps a zero budget, which switches a lane off", () => {
    expect(
      dailyBudgetUsdOf({ dailyBudgetUsd: { runEnrichment: 0 } }).runEnrichment,
    ).toBe(0);
  });

  it("returns a fresh object each time, so a caller cannot change the default", () => {
    const first = dailyBudgetUsdOf(undefined);
    first.work = 9;
    expect(dailyBudgetUsdOf(undefined).work).toBeNull();
    expect(NO_DAILY_BUDGET.work).toBeNull();
  });
});

describe("laneBudgetUsd", () => {
  it("answers one lane by its lane name", () => {
    const settings = {
      dailyBudgetUsd: { runEnrichment: 1, assistant: 2, work: 3 },
    };
    expect(SPEND_LANES.map((lane) => laneBudgetUsd(settings, lane))).toEqual([
      1, 2, 3,
    ]);
    expect(laneBudgetUsd({}, "work")).toBeNull();
  });
});
