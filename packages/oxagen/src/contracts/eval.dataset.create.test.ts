import { describe, expect, it } from "vitest";
import { evalDatasetCreate } from "./eval.dataset.create";
import { getCapability } from "../registry";

describe("eval.dataset.create capability", () => {
  it("parses a minimal valid input", () => {
    const parsed = evalDatasetCreate.input.parse({
      name: "Support QA",
    });
    expect(parsed.name).toBe("Support QA");
    expect(parsed.slug).toBeUndefined();
    expect(parsed.description).toBeUndefined();
  });

  it("parses input with all optional fields", () => {
    const parsed = evalDatasetCreate.input.parse({
      name: "Support QA",
      slug: "support-qa",
      description: "Cases sampled from support chats.",
    });
    expect(parsed.slug).toBe("support-qa");
    expect(parsed.description).toBe("Cases sampled from support chats.");
  });

  it("rejects an empty name", () => {
    expect(() => evalDatasetCreate.input.parse({ name: "" })).toThrow();
  });

  it("rejects a non-kebab slug", () => {
    expect(() =>
      evalDatasetCreate.input.parse({ name: "x", slug: "Bad Slug" }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const out = evalDatasetCreate.output.parse({
      datasetId: "ds_1",
      publicId: "ds_pub_1",
      slug: "support-qa",
    });
    expect(out.slug).toBe("support-qa");
  });

  it("rejects an output missing a required field", () => {
    expect(() =>
      evalDatasetCreate.output.parse({
        datasetId: "ds_1",
        publicId: "ds_pub_1",
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("create_dataset")).toBe(evalDatasetCreate);
  });
});
