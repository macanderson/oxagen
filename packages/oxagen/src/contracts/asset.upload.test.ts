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

  it("parses valid input — video kind", () => {
    expect(() =>
      assetUpload.input.parse({
        sourceUrl: "https://example.com/clip.mp4",
        kind: "video",
      }),
    ).not.toThrow();
  });

  it("parses valid input — user_upload source with conversationId", () => {
    expect(() =>
      assetUpload.input.parse({
        sourceUrl: "https://example.com/photo.png",
        kind: "image",
        source: "user_upload",
        conversationId: "conv_abc123",
      }),
    ).not.toThrow();
  });

  it("rejects input with an unknown kind", () => {
    expect(() =>
      assetUpload.input.parse({
        sourceUrl: "https://example.com/file.png",
        kind: "spreadsheet",
      }),
    ).toThrow();
  });

  it("rejects input with an unknown source", () => {
    expect(() =>
      assetUpload.input.parse({
        sourceUrl: "https://example.com/file.png",
        kind: "image",
        source: "generated",
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

  it("parses a valid output — legacy public path (publicId null)", () => {
    expect(() =>
      assetUpload.output.parse({
        url: "https://cdn.example.com/image/org-1/uuid.webp",
        key: "image/org-1/uuid.webp",
        contentType: "image/webp",
        bytes: 12345,
        publicId: null,
      }),
    ).not.toThrow();
  });

  it("parses a valid output — user_upload path (relative serve URL + publicId)", () => {
    expect(() =>
      assetUpload.output.parse({
        url: "/api/v1/assets/gen_abc123",
        key: "generated/images/org-1/uuid.png",
        contentType: "image/png",
        bytes: 12345,
        publicId: "gen_abc123",
      }),
    ).not.toThrow();
  });

  it("rejects output missing publicId", () => {
    expect(() =>
      assetUpload.output.parse({
        url: "https://cdn.example.com/image/org-1/uuid.webp",
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
        publicId: null,
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
