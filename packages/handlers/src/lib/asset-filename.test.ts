import { describe, it, expect } from "vitest";
import {
  extensionForAsset,
  slugify,
  assetDisplayName,
  assetDispositionType,
  contentDispositionHeader,
} from "./asset-filename";

describe("extensionForAsset", () => {
  it("derives the extension from the mimeType", () => {
    expect(extensionForAsset("image/png", "image")).toBe(".png");
    expect(extensionForAsset("image/jpeg", "image")).toBe(".jpg");
    expect(extensionForAsset("text/markdown", "document")).toBe(".md");
    expect(extensionForAsset("application/pdf", "pdf")).toBe(".pdf");
    expect(
      extensionForAsset(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "document",
      ),
    ).toBe(".docx");
  });

  it("ignores mimeType parameters (charset)", () => {
    expect(extensionForAsset("text/markdown; charset=utf-8", "document")).toBe(
      ".md",
    );
  });

  it("maps Mermaid diagram source to .mmd", () => {
    expect(extensionForAsset("text/vnd.mermaid", "document")).toBe(".mmd");
  });

  it("maps SVG to .svg", () => {
    expect(extensionForAsset("image/svg+xml", "image")).toBe(".svg");
  });

  it("falls back to the kind extension when the mimeType is unknown", () => {
    expect(extensionForAsset("application/octet-stream", "archive")).toBe(
      ".zip",
    );
    expect(extensionForAsset("application/octet-stream", "image")).toBe(".png");
    expect(extensionForAsset("application/octet-stream", "spreadsheet")).toBe(
      ".xlsx",
    );
  });

  it("returns empty string for a fully unknown type+kind", () => {
    expect(extensionForAsset("application/octet-stream", "mystery")).toBe("");
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("USS Nautilus Polar Crossing")).toBe(
      "uss-nautilus-polar-crossing",
    );
  });

  it("collapses punctuation and whitespace runs into single hyphens", () => {
    expect(slugify("USS Nautilus: The First!! Nuclear   Submarine")).toBe(
      "uss-nautilus-the-first-nuclear-submarine",
    );
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("  -Hello, World-  ")).toBe("hello-world");
  });

  it("strips diacritics", () => {
    expect(slugify("Café Résumé")).toBe("cafe-resume");
  });

  it("returns empty string for punctuation-only input", () => {
    expect(slugify("!!!???")).toBe("");
  });
});

describe("assetDisplayName", () => {
  it("produces a url-friendly slug WITH the mimeType extension", () => {
    expect(
      assetDisplayName({
        prompt: "A sunset over the ocean",
        kind: "image",
        mimeType: "image/png",
        publicId: "gen_abc12345",
      }),
    ).toBe("a-sunset-over-the-ocean.png");
  });

  it("prefers the precise mimeType extension over the kind", () => {
    expect(
      assetDisplayName({
        prompt: "A sunset over the ocean",
        kind: "image",
        mimeType: "image/webp",
        publicId: "gen_abc12345",
      }),
    ).toBe("a-sunset-over-the-ocean.webp");
  });

  it("strips a leading instruction verb from the prompt", () => {
    // "Generate markdown: <title>" → the title, not the command.
    expect(
      assetDisplayName({
        prompt: "Generate markdown: USS Nautilus: The First Nuclear Submarine",
        kind: "document",
        mimeType: "text/markdown",
        publicId: "gen_xyz98765",
      }),
    ).toBe("uss-nautilus-the-first-nuclear-submarine.md");
  });

  it("prefers an explicit displayName (metadata title) over the prompt", () => {
    expect(
      assetDisplayName({
        prompt: "Generate markdown: ignore me",
        displayName: "Polar Crossing Report",
        kind: "document",
        mimeType: "text/markdown",
        publicId: "gen_xyz98765",
      }),
    ).toBe("polar-crossing-report.md");
  });

  it("falls back to '<kind>-<id suffix>' when there is no usable text", () => {
    expect(
      assetDisplayName({
        prompt: "",
        kind: "image",
        mimeType: "image/png",
        publicId: "gen_image_ABC12345",
      }),
    ).toBe("image-abc12345.png");
  });

  it("truncates a long base at a hyphen boundary, then appends the extension", () => {
    const name = assetDisplayName({
      prompt: "word ".repeat(40), // ~200 chars of "word word word…"
      kind: "image",
      mimeType: "image/png",
      publicId: "gen_abc12345",
    });
    expect(name.endsWith(".png")).toBe(true);
    const base = name.slice(0, name.length - ".png".length);
    expect(base.length).toBeLessThanOrEqual(60);
    // Never ends mid-token with a dangling hyphen.
    expect(base.endsWith("-")).toBe(false);
  });

  it("tolerates a null prompt", () => {
    expect(
      assetDisplayName({
        prompt: null,
        kind: "video",
        mimeType: "video/mp4",
        publicId: "gen_vvvv1234",
      }),
    ).toBe("video-vvvv1234.mp4");
  });
});

describe("assetDispositionType", () => {
  it("serves browser-renderable types inline", () => {
    expect(assetDispositionType("image/png")).toBe("inline");
    expect(assetDispositionType("video/mp4")).toBe("inline");
    expect(assetDispositionType("audio/mpeg")).toBe("inline");
    expect(assetDispositionType("application/pdf")).toBe("inline");
    expect(assetDispositionType("text/markdown")).toBe("inline");
    expect(assetDispositionType("text/plain; charset=utf-8")).toBe("inline");
  });

  it("forces SVG to attachment (stored-XSS defence)", () => {
    expect(assetDispositionType("image/svg+xml")).toBe("attachment");
  });

  it("forces every browser-executable markup type to attachment, not just SVG", () => {
    // nosniff stops a GUESSED type, not an honest text/html — an inline one
    // would be stored XSS on the app's own origin.
    expect(assetDispositionType("text/html")).toBe("attachment");
    expect(assetDispositionType("text/html; charset=utf-8")).toBe("attachment");
    expect(assetDispositionType("application/xhtml+xml")).toBe("attachment");
    expect(assetDispositionType("text/xml")).toBe("attachment");
    expect(assetDispositionType("application/xml")).toBe("attachment");
  });

  it("serves Mermaid source inline (text/*, safe under nosniff)", () => {
    expect(assetDispositionType("text/vnd.mermaid")).toBe("inline");
  });

  it("downloads office/zip binaries", () => {
    expect(
      assetDispositionType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("attachment");
    expect(assetDispositionType("application/zip")).toBe("attachment");
  });
});

describe("contentDispositionHeader", () => {
  it("includes the ascii filename and the RFC 5987 filename*", () => {
    expect(contentDispositionHeader("attachment", "report.pdf")).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it("uses inline disposition for viewable files", () => {
    expect(contentDispositionHeader("inline", "diagram.md")).toBe(
      `inline; filename="diagram.md"; filename*=UTF-8''diagram.md`,
    );
  });

  it("neutralises quote/backslash to prevent header injection", () => {
    const header = contentDispositionHeader("attachment", 'a"b\\c.png');
    // No raw quote/backslash survives in the ascii fallback segment.
    const ascii = header.split("; filename*=")[0];
    expect(ascii).toBe('attachment; filename="a_b_c.png"');
  });
});
