import { describe, expect, it } from "vitest";
import { evalDatasetGet } from "./eval.dataset.get";
import { getCapability } from "../registry";

describe("eval.dataset.get capability", () => {
  it("parses a minimal valid input and applies defaults", () => {
    const parsed = evalDatasetGet.input.parse({
      datasetPublicId: "ds_pub_1",
    });
    expect(parsed.datasetPublicId).toBe("ds_pub_1");
    expect(parsed.limit).toBe(50);
    expect(parsed.cursor).toBeUndefined();
  });

  it("parses input with explicit limit and cursor", () => {
    const parsed = evalDatasetGet.input.parse({
      datasetPublicId: "ds_pub_1",
      limit: 10,
      cursor: "item_pub_5",
    });
    expect(parsed.limit).toBe(10);
    expect(parsed.cursor).toBe("item_pub_5");
  });

  it("rejects a missing datasetPublicId", () => {
    expect(() => evalDatasetGet.input.parse({})).toThrow();
  });

  it("rejects a limit over the max of 200", () => {
    expect(() =>
      evalDatasetGet.input.parse({ datasetPublicId: "ds_pub_1", limit: 201 }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const out = evalDatasetGet.output.parse({
      dataset: {
        datasetId: "ds_1",
        name: "Support QA",
        slug: "support-qa",
        description: null,
        source: "manual",
        itemCount: 1,
        createdAt: "2026-07-01T00:00:00.000Z",
      },
      items: [
        {
          itemId: "item_1",
          input: "How do I reset my password?",
          expectedOutput: null,
          metadata: {},
        },
      ],
      nextCursor: null,
    });
    expect(out.items).toHaveLength(1);
    expect(out.nextCursor).toBeNull();
  });

  it("rejects an output missing the items array", () => {
    expect(() =>
      evalDatasetGet.output.parse({
        dataset: {
          datasetId: "ds_1",
          name: "Support QA",
          slug: "support-qa",
          description: null,
          source: "manual",
          itemCount: 1,
          createdAt: "2026-07-01T00:00:00.000Z",
        },
        nextCursor: null,
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("eval.dataset.get")).toBe(evalDatasetGet);
  });
});
