import { describe, expect, it } from "vitest";
import { evalDatasetList } from "./eval.dataset.list";
import { getCapability } from "../registry";

describe("eval.dataset.list capability", () => {
  it("parses an empty input object", () => {
    const parsed = evalDatasetList.input.parse({});
    expect(parsed).toEqual({});
  });

  it("rejects input with unexpected extra properties of the wrong type", () => {
    // input is z.object({}) — non-object input must be rejected
    expect(() => evalDatasetList.input.parse("not-an-object")).toThrow();
  });

  it("parses a valid output", () => {
    const out = evalDatasetList.output.parse({
      datasets: [
        {
          datasetId: "ds_1",
          name: "Support QA",
          slug: "support-qa",
          description: null,
          source: "manual",
          itemCount: 12,
          createdAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
    expect(out.datasets).toHaveLength(1);
    expect(out.datasets[0]?.source).toBe("manual");
  });

  it("rejects an output with an invalid source value", () => {
    expect(() =>
      evalDatasetList.output.parse({
        datasets: [
          {
            datasetId: "ds_1",
            name: "Support QA",
            slug: "support-qa",
            description: null,
            source: "synthetic",
            itemCount: 12,
            createdAt: "2026-07-01T00:00:00.000Z",
          },
        ],
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("list_datasets")).toBe(evalDatasetList);
  });
});
