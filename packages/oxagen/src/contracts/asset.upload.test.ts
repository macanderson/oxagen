import { describe, it, expect } from "vitest";
import { assetUpload } from "./asset.upload";
import { getCapability } from "../registry";

describe("asset.upload capability", () => {
  it("is registered", () => {
    expect(getCapability("asset.upload")).toBeDefined();
  });

  it("parses valid input — image kind", () => {
    expect(() =>
      assetUpload.input.parse({
        sourceUrl: "https://example.com/photo.png",
        kind: "image",
      }),
    ).not.toThrow();
  });

  it("parses valid input — avatar kind with optional filename", () => {
    expect(() =>
      assetUpload.input.parse({
        sourceUrl: "https://cdn.example.com/avatar.webp",
        kind: "avatar",
        filename: "my-avatar.webp",
      }),
    ).not.toThrow();
  });

  it("parses valid input — document kind", () => {
    expect(() =>
      assetUpload.input.parse({
        sourceUrl: "https://example.com/report.pdf",
        kind: "document",
      }),
    ).not.toThrow();
  });

  it("rejects input with a bad sourceUrl (not a URL)", () => {
    expect(() =>
      assetUpload.input.parse({
        sourceUrl: "not-a-url",
        kind: "image",
      }),
    ).toThrow();
  });

  it("rejects input with an unknown kind", () => {
    expect(() =>
      assetUpload.input.parse({
        sourceUrl: "https://example.com/file.png",
        kind: "video",
      }),
    ).toThrow();
  });

  it("rejects input with a filename that is too long", () => {
    expect(() =>
      assetUpload.input.parse({
        sourceUrl: "https://example.com/file.png",
        kind: "image",
        filename: "x".repeat(201),
      }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    expect(() =>
      assetUpload.output.parse({
        url: "https://cdn.example.com/image/org-1/uuid.webp",
        key: "image/org-1/uuid.webp",
        contentType: "image/webp",
        bytes: 12345,
      }),
    ).not.toThrow();
  });

  it("rejects output with invalid url", () => {
    expect(() =>
      assetUpload.output.parse({
        url: "not-a-url",
        key: "image/org-1/uuid.webp",
        contentType: "image/webp",
        bytes: 12345,
      }),
    ).toThrow();
  });

  it("rejects output with negative bytes", () => {
    expect(() =>
      assetUpload.output.parse({
        url: "https://cdn.example.com/image/org-1/uuid.webp",
        key: "image/org-1/uuid.webp",
        contentType: "image/webp",
        bytes: -1,
      }),
    ).toThrow();
  });

  it("capability has correct defaults", () => {
    expect(assetUpload.defaultEffect).toBe("deny");
    expect(assetUpload.defaultRoles?.org?.Owner).toBe("allow");
    expect(assetUpload.defaultRoles?.org?.Admin).toBe("allow");
    expect(assetUpload.defaultRoles?.workspace?.Owner).toBe("allow");
    expect(assetUpload.defaultRoles?.workspace?.Member).toBe("allow");
  });
});
