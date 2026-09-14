import { describe, expect, it } from "vitest";
import {
  Currency,
  Money,
  PublicId,
  RecordKind,
  ReplayGrade,
  Verdict,
} from "./common";

describe("PublicId", () => {
  it.each(["run_01K5RS7M2E8FJ3QW", "usr_marcusbell", "apk_9"])(
    "accepts %s",
    (id) => {
      expect(PublicId.safeParse(id).success).toBe(true);
    },
  );

  it.each([
    "run-01K5",
    "Run_01",
    "_01",
    "run_",
    "run_01 ",
    "913d6df1-0000-4000-8000-000000000000",
  ])("rejects %s", (id) => {
    expect(PublicId.safeParse(id).success).toBe(false);
  });
});

describe("Money", () => {
  it("accepts integer micros as a decimal string, with or without a basis", () => {
    expect(Money.parse({ micros: "2450000000", currency: "USD" })).toEqual({
      micros: "2450000000",
      currency: "USD",
    });
    expect(
      Money.parse({ micros: "-15", currency: "EUR", basis: "estimated" }).basis,
    ).toBe("estimated");
  });

  it.each([
    ["a display string", "2,450.00"],
    ["a decimal", "2450.5"],
    ["an empty string", ""],
  ])("rejects %s", (_label, micros) => {
    expect(Money.safeParse({ micros, currency: "USD" }).success).toBe(false);
  });

  it("rejects a float number, which would lose precision", () => {
    expect(Money.safeParse({ micros: 2450.5, currency: "USD" }).success).toBe(
      false,
    );
  });

  it("rejects an unknown basis and a malformed currency", () => {
    expect(
      Money.safeParse({ micros: "1", currency: "USD", basis: "guessed" })
        .success,
    ).toBe(false);
    expect(Currency.safeParse("US").success).toBe(false);
  });
});

describe("spec vocabulary", () => {
  it("uses the spec's replay grades, not the mockup's", () => {
    expect(ReplayGrade.options).toEqual(["inspect", "view", "fork", "retry"]);
    expect(ReplayGrade.safeParse("full").success).toBe(false);
  });

  it("spells an absent verdict `none`, never null", () => {
    expect(Verdict.safeParse("none").success).toBe(true);
    expect(Verdict.safeParse(null).success).toBe(false);
  });

  it("has exactly the six record kinds", () => {
    expect(RecordKind.options).toHaveLength(6);
  });
});
