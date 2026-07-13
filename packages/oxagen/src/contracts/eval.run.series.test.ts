import { describe, expect, it } from "vitest";
import { evalRunSeries } from "./eval.run.series";
import { getCapability } from "../registry";

describe("eval.run.series capability", () => {
  it("defaults bucket to day on a bare input", () => {
    const parsed = evalRunSeries.input.parse({});
    expect(parsed.bucket).toBe("day");
    expect(parsed.datasetPublicId).toBeUndefined();
  });

  it("parses explicit dataset, range, and bucket", () => {
    const parsed = evalRunSeries.input.parse({
      datasetPublicId: "evd_1",
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-02-01T00:00:00.000Z",
      bucket: "week",
    });
    expect(parsed.bucket).toBe("week");
    expect(parsed.datasetPublicId).toBe("evd_1");
  });

  it("rejects an unknown bucket", () => {
    expect(() => evalRunSeries.input.parse({ bucket: "month" })).toThrow();
  });

  it("rejects a non-datetime until", () => {
    expect(() => evalRunSeries.input.parse({ until: "soon" })).toThrow();
  });

  it("parses a valid output", () => {
    const out = evalRunSeries.output.parse({
      overall: [
        { bucketStart: "2026-07-01T00:00:00.000Z", avgScore: 0.9, runCount: 2 },
        {
          bucketStart: "2026-07-02T00:00:00.000Z",
          avgScore: null,
          runCount: 0,
        },
      ],
      byModel: [
        {
          model: "anthropic/claude-opus-4.8",
          vendor: "anthropic",
          avgScore: 0.9,
          passRate: 1,
          runCount: 2,
          points: [{ bucketStart: "2026-07-01T00:00:00.000Z", avgScore: 0.9 }],
        },
      ],
    });
    expect(out.overall).toHaveLength(2);
    expect(out.byModel[0]?.vendor).toBe("anthropic");
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("get_eval_run_series")).toBe(evalRunSeries);
  });
});
