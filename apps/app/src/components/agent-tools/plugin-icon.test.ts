import { describe, expect, it } from "vitest";
import { isRenderableImageUrl } from "./plugin-icon";

describe("isRenderableImageUrl", () => {
  it("accepts absolute http(s) URLs", () => {
    expect(isRenderableImageUrl("https://example.com/icon.png")).toBe(true);
    expect(isRenderableImageUrl("http://example.com/icon.svg")).toBe(true);
  });

  it("accepts root-relative paths", () => {
    expect(isRenderableImageUrl("/icons/plug.png")).toBe(true);
  });

  it("rejects Lucide icon names (the capability-pack regression)", () => {
    // Capability packs historically persisted manifest.icon (a Lucide name)
    // into iconUrl; feeding these to next/image threw "Invalid URL".
    expect(isRenderableImageUrl("image")).toBe(false);
    expect(isRenderableImageUrl("shapes")).toBe(false);
    expect(isRenderableImageUrl("file-text")).toBe(false);
  });

  it("rejects null, undefined, and empty values", () => {
    expect(isRenderableImageUrl(null)).toBe(false);
    expect(isRenderableImageUrl(undefined)).toBe(false);
    expect(isRenderableImageUrl("")).toBe(false);
  });

  it("rejects bare protocol-relative or relative strings", () => {
    expect(isRenderableImageUrl("example.com/icon.png")).toBe(false);
    expect(isRenderableImageUrl("./icon.png")).toBe(false);
  });
});
