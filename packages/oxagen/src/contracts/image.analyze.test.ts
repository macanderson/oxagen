import { describe, expect, it } from "vitest";
import { imageAnalyze } from "./image.analyze";
import { getCapability } from "../registry";

describe("image.analyze capability", () => {
  // ── input schema ──────────────────────────────────────────────────────────

  it("accepts a valid image_id string", () => {
    const parsed = imageAnalyze.input.parse({ image_id: "img_abc123" });
    expect(parsed.image_id).toBe("img_abc123");
  });

  it("rejects input missing image_id", () => {
    expect(() => imageAnalyze.input.parse({})).toThrow();
  });

  it("rejects non-string image_id", () => {
    expect(() => imageAnalyze.input.parse({ image_id: 42 })).toThrow();
  });

  it("rejects null image_id", () => {
    expect(() => imageAnalyze.input.parse({ image_id: null })).toThrow();
  });

  // ── output schema ─────────────────────────────────────────────────────────

  it("parses a valid output with analysis, tags, and description", () => {
    const parsed = imageAnalyze.output.parse({
      analysis: "The image shows a sunset over mountains.",
      tags: ["sunset", "mountains", "landscape"],
      description: "A scenic mountain sunset.",
    });
    expect(parsed.analysis).toBe("The image shows a sunset over mountains.");
    expect(parsed.tags).toEqual(["sunset", "mountains", "landscape"]);
    expect(parsed.description).toBe("A scenic mountain sunset.");
  });

  it("parses output with an empty tags array", () => {
    const parsed = imageAnalyze.output.parse({
      analysis: "No distinctive features.",
      tags: [],
      description: "Blank image.",
    });
    expect(parsed.tags).toHaveLength(0);
  });

  it("rejects output missing analysis", () => {
    expect(() =>
      imageAnalyze.output.parse({
        tags: ["a"],
        description: "desc",
      }),
    ).toThrow();
  });

  it("rejects output missing tags", () => {
    expect(() =>
      imageAnalyze.output.parse({
        analysis: "ok",
        description: "desc",
      }),
    ).toThrow();
  });

  it("rejects output missing description", () => {
    expect(() =>
      imageAnalyze.output.parse({
        analysis: "ok",
        tags: [],
      }),
    ).toThrow();
  });

  it("rejects output where tags is not an array", () => {
    expect(() =>
      imageAnalyze.output.parse({
        analysis: "ok",
        tags: "sunset",
        description: "desc",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("image.analyze")).toBe(imageAnalyze);
  });
});
