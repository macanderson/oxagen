// A collector's health follows its reconciles and its nightly count, and a
// paused collector stays paused until a person moves it.
import { describe, expect, it } from "vitest";
import {
  COLLECTOR_HEALTH_VALUES,
  type CollectorHealth,
  FAILING_AFTER_FAILED_RECONCILES,
  type HealthSignals,
  healthOf,
  isCollectorHealth,
} from "../health";

const CLEAR: HealthSignals = {
  failedStreak: 0,
  lastReconcileMissed: 0,
  lastCountDiffered: false,
};

const NOT_PAUSED: readonly CollectorHealth[] = ["healthy", "lagging", "failing"];

describe("healthOf", () => {
  it("keeps a paused collector paused whatever the signals say", () => {
    const signals: HealthSignals[] = [
      CLEAR,
      { failedStreak: 5, lastReconcileMissed: 0, lastCountDiffered: false },
      { failedStreak: 0, lastReconcileMissed: 3, lastCountDiffered: false },
      { failedStreak: 0, lastReconcileMissed: 0, lastCountDiffered: true },
      { failedStreak: 9, lastReconcileMissed: 9, lastCountDiffered: true },
    ];
    for (const signal of signals) expect(healthOf("paused", signal)).toBe("paused");
  });

  it("fails after three failed reconciles in a row", () => {
    expect(FAILING_AFTER_FAILED_RECONCILES).toBe(3);
    for (const current of NOT_PAUSED)
      expect(healthOf(current, { ...CLEAR, failedStreak: 3 })).toBe("failing");
  });

  it("stays failing for a streak longer than three", () => {
    expect(healthOf("failing", { ...CLEAR, failedStreak: 4 })).toBe("failing");
  });

  it("does not fail after only two failed reconciles in a row", () => {
    expect(healthOf("healthy", { ...CLEAR, failedStreak: 2 })).toBe("healthy");
    expect(healthOf("healthy", { ...CLEAR, failedStreak: 2, lastReconcileMissed: 1 })).toBe(
      "lagging",
    );
  });

  it("ranks failing above lagging when both hold", () => {
    expect(
      healthOf("healthy", {
        failedStreak: 3,
        lastReconcileMissed: 4,
        lastCountDiffered: true,
      }),
    ).toBe("failing");
  });

  it("lags when the last reconcile found items the doorbell missed", () => {
    for (const current of NOT_PAUSED)
      expect(healthOf(current, { ...CLEAR, lastReconcileMissed: 1 })).toBe("lagging");
  });

  it("lags when the last nightly count differed", () => {
    for (const current of NOT_PAUSED)
      expect(healthOf(current, { ...CLEAR, lastCountDiffered: true })).toBe("lagging");
  });

  it("is healthy when nothing was missed, the count matched, and no reconcile failed", () => {
    expect(healthOf("healthy", CLEAR)).toBe("healthy");
  });

  it("returns a failing or lagging collector to healthy once the signals clear", () => {
    expect(healthOf("failing", CLEAR)).toBe("healthy");
    expect(healthOf("lagging", CLEAR)).toBe("healthy");
  });
});

describe("isCollectorHealth", () => {
  it("accepts each health value work.collectors stores", () => {
    expect([...COLLECTOR_HEALTH_VALUES]).toEqual(["healthy", "lagging", "failing", "paused"]);
    for (const value of COLLECTOR_HEALTH_VALUES) expect(isCollectorHealth(value)).toBe(true);
  });

  it("rejects other strings, including a value in the wrong case", () => {
    for (const value of ["", "Healthy", "PAUSED", "removed", "healthy "])
      expect(isCollectorHealth(value)).toBe(false);
  });

  it("rejects values that are not strings", () => {
    for (const value of [null, undefined, 0, 1, true, {}, ["healthy"]])
      expect(isCollectorHealth(value)).toBe(false);
  });
});
