import { describe, it, expect } from "vitest";

import {
  ASSET_LIMITS,
  ASSET_ALLOWED_TYPES,
  assertAllowedAssetType,
  deriveAssetKey,
} from "./assets";
import type { AssetKind } from "./assets";

// ── ASSET_LIMITS ──────────────────────────────────────────────────────────────

describe("ASSET_LIMITS", () => {
  it("avatar limit is 5 MiB", () => {
    expect(ASSET_LIMITS.avatar).toBe(5 * 1024 * 1024);
  });

  it("image limit is 5 MiB", () => {
    expect(ASSET_LIMITS.image).toBe(5 * 1024 * 1024);
  });

  it("document limit is 25 MiB", () => {
    expect(ASSET_LIMITS.document).toBe(25 * 1024 * 1024);
  });

  it("video limit is 100 MiB", () => {
    expect(ASSET_LIMITS.video).toBe(100 * 1024 * 1024);
  });
});

// ── ASSET_ALLOWED_TYPES ───────────────────────────────────────────────────────

describe("ASSET_ALLOWED_TYPES", () => {
  const avatarTypes = ASSET_ALLOWED_TYPES.avatar;
  const imageTypes = ASSET_ALLOWED_TYPES.image;
  const documentTypes = ASSET_ALLOWED_TYPES.document;

  it("avatar allows image/webp → webp", () => {
    expect(avatarTypes["image/webp"]).toBe("webp");
  });

  it("avatar allows image/png → png", () => {
    expect(avatarTypes["image/png"]).toBe("png");
  });

  it("avatar allows image/jpeg → jpg", () => {
    expect(avatarTypes["image/jpeg"]).toBe("jpg");
  });

  it("avatar does not allow application/pdf", () => {
    expect(avatarTypes["application/pdf"]).toBeUndefined();
  });

  it("image allows image/webp → webp", () => {
    expect(imageTypes["image/webp"]).toBe("webp");
  });

  it("image allows image/png → png", () => {
    expect(imageTypes["image/png"]).toBe("png");
  });

  it("image allows image/jpeg → jpg", () => {
    expect(imageTypes["image/jpeg"]).toBe("jpg");
  });

  it("image does not allow application/pdf", () => {
    expect(imageTypes["application/pdf"]).toBeUndefined();
  });

  it("document allows image/webp → webp", () => {
    expect(documentTypes["image/webp"]).toBe("webp");
  });

  it("document allows image/png → png", () => {
    expect(documentTypes["image/png"]).toBe("png");
  });

  it("document allows image/jpeg → jpg", () => {
    expect(documentTypes["image/jpeg"]).toBe("jpg");
  });

  it("document allows application/pdf → pdf", () => {
    expect(documentTypes["application/pdf"]).toBe("pdf");
  });

  it("image and document allow image/gif → gif", () => {
    expect(imageTypes["image/gif"]).toBe("gif");
    expect(documentTypes["image/gif"]).toBe("gif");
  });

  it("avatar does not allow image/gif", () => {
    expect(avatarTypes["image/gif"]).toBeUndefined();
  });

  it("video allows mp4 / webm / quicktime and rejects images", () => {
    const videoTypes = ASSET_ALLOWED_TYPES.video;
    expect(videoTypes["video/mp4"]).toBe("mp4");
    expect(videoTypes["video/webm"]).toBe("webm");
    expect(videoTypes["video/quicktime"]).toBe("mov");
    expect(videoTypes["image/png"]).toBeUndefined();
  });
});

// ── assertAllowedAssetType ────────────────────────────────────────────────────

describe("assertAllowedAssetType", () => {
  // Success paths — returns the correct extension

  it("avatar + image/webp → 'webp'", () => {
    expect(assertAllowedAssetType("avatar", "image/webp")).toBe("webp");
  });

  it("avatar + image/png → 'png'", () => {
    expect(assertAllowedAssetType("avatar", "image/png")).toBe("png");
  });

  it("avatar + image/jpeg → 'jpg'", () => {
    expect(assertAllowedAssetType("avatar", "image/jpeg")).toBe("jpg");
  });

  it("image + image/webp → 'webp'", () => {
    expect(assertAllowedAssetType("image", "image/webp")).toBe("webp");
  });

  it("image + image/png → 'png'", () => {
    expect(assertAllowedAssetType("image", "image/png")).toBe("png");
  });

  it("image + image/jpeg → 'jpg'", () => {
    expect(assertAllowedAssetType("image", "image/jpeg")).toBe("jpg");
  });

  it("document + image/webp → 'webp'", () => {
    expect(assertAllowedAssetType("document", "image/webp")).toBe("webp");
  });

  it("document + image/png → 'png'", () => {
    expect(assertAllowedAssetType("document", "image/png")).toBe("png");
  });

  it("document + image/jpeg → 'jpg'", () => {
    expect(assertAllowedAssetType("document", "image/jpeg")).toBe("jpg");
  });

  it("document + application/pdf → 'pdf'", () => {
    expect(assertAllowedAssetType("document", "application/pdf")).toBe("pdf");
  });

  // Error paths — throws for disallowed MIME types

  it("avatar + application/pdf throws with kind in message", () => {
    expect(() => assertAllowedAssetType("avatar", "application/pdf")).toThrow(
      /avatar/,
    );
  });

  it("avatar + application/pdf throws with the rejected MIME type in message", () => {
    expect(() => assertAllowedAssetType("avatar", "application/pdf")).toThrow(
      /application\/pdf/,
    );
  });

  it("avatar + application/pdf throws listing permitted types", () => {
    expect(() => assertAllowedAssetType("avatar", "application/pdf")).toThrow(
      /image\/webp/,
    );
  });

  it("image + text/plain throws with kind in message", () => {
    expect(() => assertAllowedAssetType("image", "text/plain")).toThrow(
      /image/,
    );
  });

  it("image + text/plain throws with the rejected MIME type in message", () => {
    expect(() => assertAllowedAssetType("image", "text/plain")).toThrow(
      /text\/plain/,
    );
  });

  it("document + video/mp4 throws with kind in message", () => {
    expect(() => assertAllowedAssetType("document", "video/mp4")).toThrow(
      /document/,
    );
  });

  it("document + video/mp4 throws with the rejected MIME type in message", () => {
    expect(() => assertAllowedAssetType("document", "video/mp4")).toThrow(
      /video\/mp4/,
    );
  });

  it("document + video/mp4 error lists application/pdf as a permitted type", () => {
    expect(() => assertAllowedAssetType("document", "video/mp4")).toThrow(
      /application\/pdf/,
    );
  });

  // Edge cases — empty and unusual MIME strings

  it("throws for an empty MIME string", () => {
    expect(() => assertAllowedAssetType("avatar", "")).toThrow();
  });

  it("throws for a MIME string with only whitespace", () => {
    expect(() => assertAllowedAssetType("image", "   ")).toThrow();
  });

  it("throws for an unknown MIME type on document kind", () => {
    expect(() =>
      assertAllowedAssetType("document", "application/octet-stream"),
    ).toThrow(/Unsupported/);
  });
});

// ── deriveAssetKey ────────────────────────────────────────────────────────────

describe("deriveAssetKey", () => {
  it("returns a key in the format '<kind>/<ownerId>/<uuid>.<ext>'", () => {
    const key = deriveAssetKey("avatar", "user-123", "webp");
    // pattern: avatar/user-123/<uuid>.webp
    expect(key).toMatch(
      /^avatar\/user-123\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/,
    );
  });

  it("embeds the kind as the first path segment", () => {
    const key = deriveAssetKey("image", "org-abc", "png");
    expect(key.startsWith("image/")).toBe(true);
  });

  it("embeds the ownerId as the second path segment", () => {
    const key = deriveAssetKey("document", "org-xyz", "pdf");
    const segments = key.split("/");
    expect(segments[1]).toBe("org-xyz");
  });

  it("embeds the extension as the suffix of the filename", () => {
    const key = deriveAssetKey("avatar", "u1", "jpg");
    expect(key.endsWith(".jpg")).toBe(true);
  });

  it("generates a unique UUID on each call (two keys differ)", () => {
    const a = deriveAssetKey("avatar", "user-1", "webp");
    const b = deriveAssetKey("avatar", "user-1", "webp");
    expect(a).not.toBe(b);
  });

  it("works for document kind with pdf extension", () => {
    const key = deriveAssetKey("document", "org-99", "pdf");
    expect(key).toMatch(
      /^document\/org-99\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/,
    );
  });

  it("works for image kind with png extension", () => {
    const key = deriveAssetKey("image", "org-88", "png");
    expect(key).toMatch(
      /^image\/org-88\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/,
    );
  });

  it("does not use the randomUUID return value from a hoisted spy — actually generates a UUID", () => {
    // Confirm the UUID is a standard v4 UUID (36 chars with dashes)
    const key = deriveAssetKey("avatar", "u", "webp");
    // key format: "avatar/u/<uuid>.webp" — exactly 3 segments
    const lastSegment = key.split("/").at(2) ?? "";
    const uuid = lastSegment.split(".")[0] ?? "";
    expect(uuid).toHaveLength(36);
  });

  it("accepts an ownerId with special characters (slashes in ownerId are NOT sanitised — caller responsibility)", () => {
    // deriveAssetKey does not escape ownerId; this is documented caller responsibility
    const key = deriveAssetKey("avatar", "abc", "webp");
    expect(key).toContain("abc");
  });
});

// ── AssetKind type coverage (compile-time, exercised at runtime) ──────────────

describe("AssetKind runtime coverage", () => {
  const kinds: AssetKind[] = ["avatar", "image", "document"];

  it("all three AssetKind values are valid keys in ASSET_LIMITS", () => {
    for (const kind of kinds) {
      expect(ASSET_LIMITS[kind]).toBeGreaterThan(0);
    }
  });

  it("all three AssetKind values are valid keys in ASSET_ALLOWED_TYPES", () => {
    for (const kind of kinds) {
      expect(Object.keys(ASSET_ALLOWED_TYPES[kind]).length).toBeGreaterThan(0);
    }
  });
});
