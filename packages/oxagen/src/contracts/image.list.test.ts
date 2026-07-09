import { describe, expect, it } from "vitest";
import { imageList } from "./image.list";
import { getCapability } from "../registry";

describe("image.list capability", () => {
  // ── input schema ──────────────────────────────────────────────────────────

  it("parses empty input (workspace_id is optional)", () => {
    const parsed = imageList.input.parse({});
    expect(parsed.workspace_id).toBeUndefined();
  });

  it("accepts a workspace_id string", () => {
    const parsed = imageList.input.parse({ workspace_id: "ws_abc" });
    expect(parsed.workspace_id).toBe("ws_abc");
  });

  it("rejects non-string workspace_id", () => {
    expect(() => imageList.input.parse({ workspace_id: 42 })).toThrow();
  });

  // ── output schema ─────────────────────────────────────────────────────────

  it("parses a valid output with a list of images", () => {
    const parsed = imageList.output.parse({
      images: [
        {
          id: "img_001",
          url: "https://cdn.example.com/img_001.png",
          created_at: "2024-01-01T00:00:00.000Z",
          prompt: "a red cat",
        },
      ],
    });
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]?.id).toBe("img_001");
    expect(parsed.images[0]?.prompt).toBe("a red cat");
  });

  it("parses output with an empty images array", () => {
    const parsed = imageList.output.parse({ images: [] });
    expect(parsed.images).toHaveLength(0);
  });

  it("parses output with multiple image entries", () => {
    const parsed = imageList.output.parse({
      images: [
        {
          id: "img_001",
          url: "https://cdn.example.com/img_001.png",
          created_at: "2024-01-01T00:00:00.000Z",
          prompt: "a red cat",
        },
        {
          id: "img_002",
          url: "https://cdn.example.com/img_002.png",
          created_at: "2024-01-02T00:00:00.000Z",
          prompt: "a blue sky",
        },
      ],
    });
    expect(parsed.images).toHaveLength(2);
    expect(parsed.images[1]?.id).toBe("img_002");
  });

  it("rejects output missing the images key", () => {
    expect(() => imageList.output.parse({})).toThrow();
  });

  it("rejects an image entry missing prompt", () => {
    expect(() =>
      imageList.output.parse({
        images: [
          {
            id: "img_001",
            url: "https://cdn.example.com/img_001.png",
            created_at: "2024-01-01T00:00:00.000Z",
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects an image entry missing url", () => {
    expect(() =>
      imageList.output.parse({
        images: [
          {
            id: "img_001",
            created_at: "2024-01-01T00:00:00.000Z",
            prompt: "sky",
          },
        ],
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("list_images")).toBe(imageList);
  });
});
