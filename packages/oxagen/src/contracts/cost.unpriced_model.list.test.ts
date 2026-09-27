import { describe, expect, it } from "vitest";
import {
  costUnpricedModelList,
  missingClassWindowSchema,
  unpricedModelSchema,
  UNPRICED_MODEL_WINDOW_DAYS,
} from "./cost.unpriced_model.list";

const model = {
  model: "moonshot/kimi-k3",
  provider: "moonshot",
  calls: 412,
  tokens: 9_800_000,
  firstSeen: "2026-08-20T00:00:00.000Z",
  lastSeen: "2026-09-17T00:00:00.000Z",
  missingClasses: ["input_uncached", "output"],
  missingClassWindows: [
    {
      tokenClass: "input_uncached",
      unpricedFrom: "2026-08-20T00:00:00.000Z",
      unpricedTo: "2026-09-17T00:00:00.000Z",
      calls: 0,
      units: 0,
    },
    {
      tokenClass: "output",
      unpricedFrom: "2026-08-20T00:00:00.000Z",
      unpricedTo: "2026-09-17T00:00:00.000Z",
      calls: 0,
      units: 0,
    },
  ],
  fullyUnpriced: false,
};

describe("list_unpriced_models contract", () => {
  it("is a console read over an optional window", () => {
    expect(costUnpricedModelList.noBillingGate).toBe(true);
    expect(costUnpricedModelList.mutates).toBe(false);
    expect(costUnpricedModelList.input.parse({})).toEqual({});
    expect(
      costUnpricedModelList.input.safeParse({ since: "last month" }).success,
    ).toBe(false);
    expect(UNPRICED_MODEL_WINDOW_DAYS).toBeGreaterThan(0);
  });

  it("names the model, what it has run, and which classes have no price", () => {
    expect(unpricedModelSchema.parse(model)).toEqual(model);
    // A vendor the frames do not name is null, never an empty string that
    // would read as a real vendor called "".
    expect(
      unpricedModelSchema.safeParse({ ...model, provider: null }).success,
    ).toBe(true);
    expect(
      unpricedModelSchema.safeParse({ ...model, missingClasses: ["thinking"] })
        .success,
    ).toBe(false);
    // Counts are whole observations, not rates.
    expect(
      unpricedModelSchema.safeParse({ ...model, calls: 1.5 }).success,
    ).toBe(false);
    expect(unpricedModelSchema.safeParse({ ...model, calls: -1 }).success).toBe(
      false,
    );
  });

  it("carries no cost figure at all — an unpriced model is not a free one", () => {
    expect(Object.keys(unpricedModelSchema.shape)).not.toContain("cost");
    expect(Object.keys(unpricedModelSchema.shape)).not.toContain(
      "microsPerMillion",
    );
  });

  it("names the window each missing class went unpriced over", () => {
    expect(
      missingClassWindowSchema.parse({
        tokenClass: "reasoning",
        unpricedFrom: "2026-09-01T00:00:00.000Z",
        unpricedTo: "2026-09-05T00:00:00.000Z",
        calls: 0,
        units: 0,
      }),
    ).toEqual({
      tokenClass: "reasoning",
      unpricedFrom: "2026-09-01T00:00:00.000Z",
      unpricedTo: "2026-09-05T00:00:00.000Z",
      calls: 0,
      units: 0,
    });
    expect(
      missingClassWindowSchema.safeParse({
        tokenClass: "not-a-class",
        unpricedFrom: "2026-09-01T00:00:00.000Z",
        unpricedTo: "2026-09-05T00:00:00.000Z",
        calls: 0,
        units: 0,
      }).success,
    ).toBe(false);
  });
});
