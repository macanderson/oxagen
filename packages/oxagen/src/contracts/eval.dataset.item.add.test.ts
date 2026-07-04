import { describe, expect, it } from "vitest";
import { evalDatasetItemAdd } from "./eval.dataset.item.add";
import { getCapability } from "../registry";

describe("eval.dataset.item.add capability", () => {
  it("parses a minimal valid input and applies item defaults", () => {
    const parsed = evalDatasetItemAdd.input.parse({
      datasetPublicId: "ds_pub_1",
      items: [{ input: "What is our refund policy?" }],
    });
    expect(parsed.datasetPublicId).toBe("ds_pub_1");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.metadata).toEqual({});
    expect(parsed.items[0]?.expectedOutput).toBeUndefined();
  });

  it("parses input with expectedOutput and metadata", () => {
    const parsed = evalDatasetItemAdd.input.parse({
      datasetPublicId: "ds_pub_1",
      items: [
        {
          input: "What is our refund policy?",
          expectedOutput: "30 days, no questions asked.",
          metadata: { messageId: "msg_1" },
        },
      ],
    });
    expect(parsed.items[0]?.expectedOutput).toBe(
      "30 days, no questions asked.",
    );
    expect(parsed.items[0]?.metadata).toEqual({ messageId: "msg_1" });
  });

  it("rejects an empty items array", () => {
    expect(() =>
      evalDatasetItemAdd.input.parse({
        datasetPublicId: "ds_pub_1",
        items: [],
      }),
    ).toThrow();
  });

  it("rejects more than 1000 items", () => {
    expect(() =>
      evalDatasetItemAdd.input.parse({
        datasetPublicId: "ds_pub_1",
        items: Array.from({ length: 1001 }, () => ({ input: "x" })),
      }),
    ).toThrow();
  });

  it("rejects an item with an empty input string", () => {
    expect(() =>
      evalDatasetItemAdd.input.parse({
        datasetPublicId: "ds_pub_1",
        items: [{ input: "" }],
      }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const out = evalDatasetItemAdd.output.parse({
      datasetId: "ds_1",
      added: 1,
      itemCount: 5,
    });
    expect(out.added).toBe(1);
    expect(out.itemCount).toBe(5);
  });

  it("rejects a negative added count in output", () => {
    expect(() =>
      evalDatasetItemAdd.output.parse({
        datasetId: "ds_1",
        added: -1,
        itemCount: 5,
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("eval.dataset.item.add")).toBe(evalDatasetItemAdd);
  });
});
