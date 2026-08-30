import { describe, expect, it } from "vitest";
import { evalDatasetFromTraces } from "./eval.dataset.from_traces";
import { getCapability } from "../registry";

describe("eval.dataset.from_traces capability", () => {
  it("parses a minimal valid input and applies defaults", () => {
    const parsed = evalDatasetFromTraces.input.parse({
      name: "Recent chat traces",
    });
    expect(parsed.name).toBe("Recent chat traces");
    expect(parsed.sinceHours).toBe(24 * 7);
    expect(parsed.limit).toBe(50);
    expect(parsed.slug).toBeUndefined();
    expect(parsed.capabilityName).toBeUndefined();
  });

  it("parses input with all optional fields", () => {
    const parsed = evalDatasetFromTraces.input.parse({
      name: "Recent chat traces",
      slug: "recent-chat-traces",
      description: "Sampled from chat.message.send",
      capabilityName: "send_message",
      sinceHours: 48,
      limit: 100,
    });
    expect(parsed.slug).toBe("recent-chat-traces");
    expect(parsed.capabilityName).toBe("send_message");
    expect(parsed.sinceHours).toBe(48);
    expect(parsed.limit).toBe(100);
  });

  it("rejects an empty name", () => {
    expect(() => evalDatasetFromTraces.input.parse({ name: "" })).toThrow();
  });

  it("rejects sinceHours over the 90-day max", () => {
    expect(() =>
      evalDatasetFromTraces.input.parse({
        name: "x",
        sinceHours: 24 * 90 + 1,
      }),
    ).toThrow();
  });

  it("rejects limit over the max of 500", () => {
    expect(() =>
      evalDatasetFromTraces.input.parse({ name: "x", limit: 501 }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const out = evalDatasetFromTraces.output.parse({
      datasetId: "ds_1",
      publicId: "ds_pub_1",
      slug: "recent-chat-traces",
      itemCount: 42,
    });
    expect(out.itemCount).toBe(42);
  });

  it("rejects a non-integer itemCount in output", () => {
    expect(() =>
      evalDatasetFromTraces.output.parse({
        datasetId: "ds_1",
        publicId: "ds_pub_1",
        slug: "recent-chat-traces",
        itemCount: 4.5,
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("create_trace_dataset")).toBe(evalDatasetFromTraces);
  });
});
