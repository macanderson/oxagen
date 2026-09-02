import { describe, expect, it } from "vitest";
import { imageCreate } from "./image.create";
import { getCapability } from "../registry";

describe("image.create capability", () => {
  // ── input defaults ────────────────────────────────────────────────────────

  it("defaults model to 'gpt-image-1'", () => {
    const parsed = imageCreate.input.parse({ prompt: "a red cat" });
    expect(parsed.model).toBe("gpt-image-1");
  });

  it("leaves size undefined when not provided", () => {
    const parsed = imageCreate.input.parse({ prompt: "a red cat" });
    expect(parsed.size).toBeUndefined();
  });

  // ── prompt validation ─────────────────────────────────────────────────────

  it("accepts a minimal valid prompt", () => {
    const parsed = imageCreate.input.parse({ prompt: "x" });
    expect(parsed.prompt).toBe("x");
  });

  it("rejects an empty prompt (min=1)", () => {
    expect(() => imageCreate.input.parse({ prompt: "" })).toThrow();
  });

  it("rejects input missing prompt", () => {
    expect(() => imageCreate.input.parse({})).toThrow();
  });

  it("rejects non-string prompt", () => {
    expect(() => imageCreate.input.parse({ prompt: 123 })).toThrow();
  });

  // ── model enum ────────────────────────────────────────────────────────────

  it("accepts model='flux-2-max'", () => {
    const parsed = imageCreate.input.parse({
      prompt: "sky",
      model: "flux-2-max",
    });
    expect(parsed.model).toBe("flux-2-max");
  });

  it("rejects an unknown model value", () => {
    expect(() =>
      imageCreate.input.parse({ prompt: "sky", model: "dall-e-3" }),
    ).toThrow();
  });

  // ── size optional ─────────────────────────────────────────────────────────

  it("accepts a size string when provided", () => {
    const parsed = imageCreate.input.parse({
      prompt: "sky",
      size: "1024x1024",
    });
    expect(parsed.size).toBe("1024x1024");
  });

  // ── output schema ─────────────────────────────────────────────────────────

  it("parses a valid output with image_id, url, and created_at", () => {
    const parsed = imageCreate.output.parse({
      image_id: "img_001",
      url: "https://cdn.example.com/img_001.png",
      created_at: "2024-01-01T00:00:00.000Z",
    });
    expect(parsed.image_id).toBe("img_001");
    expect(parsed.url).toBe("https://cdn.example.com/img_001.png");
    expect(parsed.created_at).toBe("2024-01-01T00:00:00.000Z");
  });

  it("rejects output missing image_id", () => {
    expect(() =>
      imageCreate.output.parse({
        url: "https://cdn.example.com/img_001.png",
        created_at: "2024-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output missing url", () => {
    expect(() =>
      imageCreate.output.parse({
        image_id: "img_001",
        created_at: "2024-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output missing created_at", () => {
    expect(() =>
      imageCreate.output.parse({
        image_id: "img_001",
        url: "https://cdn.example.com/img_001.png",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("create_image")).toBe(imageCreate);
  });
});
