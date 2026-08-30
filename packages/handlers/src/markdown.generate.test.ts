/**
 * markdown.generate handler tests.
 *
 * Strategy: mock `persistGeneratedAsset` at the module level so no real blob
 * upload or DB insert occurs. Assert:
 *   - the handler encodes the markdown source to UTF-8 bytes
 *   - when no `markdown` field is supplied, sections are assembled into a
 *     CommonMark string (H1 title + H2 headings + paragraphs)
 *   - when neither `markdown` nor `sections` is supplied, the fallback is an
 *     H1-only document from the title
 *   - persistGeneratedAsset is called with kind='markdown', mimeType='text/markdown'
 *   - the output shape matches the contract (assetId, publicId, kind, mimeType,
 *     sizeBytes, url, serveUrl, render directive)
 *   - the render directive carries `file-attachment` with the correct props
 *   - the filename has a .md extension
 *   - error paths surface correctly
 *   - the handler throws when userId is absent from context
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Fake asset returned by persistGeneratedAsset ──────────────────────────────
const FAKE_ASSET = {
  id: "asset-uuid-md",
  publicId: "gen_MDTEST",
  kind: "markdown" as const,
  mimeType: "text/markdown",
  sizeBytes: 256,
  url: "https://blob.example.com/doc.md",
  serveUrl: "/api/v1/assets/gen_MDTEST",
};

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  persistGeneratedAsset: vi.fn(),
}));

vi.mock("./generated-asset.persist", () => ({
  persistGeneratedAsset: mocks.persistGeneratedAsset,
}));

// ── Import handler after mocks ────────────────────────────────────────────────
import { markdownGenerateHandler } from "./markdown.generate";
import { TEST_CTX as CTX, makeCTX } from "./test-utils/fixtures";

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mocks.persistGeneratedAsset.mockResolvedValue(FAKE_ASSET);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("markdownGenerateHandler — raw markdown source", () => {
  it("encodes raw markdown to UTF-8 bytes and persists under the document kind", async () => {
    const source = "# Hello\n\nWorld.";
    await markdownGenerateHandler({ title: "Hello", markdown: source }, CTX);

    expect(mocks.persistGeneratedAsset).toHaveBeenCalledTimes(1);
    const arg = mocks.persistGeneratedAsset.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    // Markdown is stored under the DB `document` kind (the kind CHECK constraint
    // has no dedicated "markdown" kind); the render directive still tags it markdown.
    expect(arg.kind).toBe("document");
    expect(arg.mimeType).toBe("text/markdown");
    expect(arg.bytes).toBeInstanceOf(Uint8Array);

    // Verify UTF-8 round-trip.
    const decoded = new TextDecoder().decode(arg.bytes as Uint8Array);
    expect(decoded).toBe(source);
  });

  it("output shape matches contract", async () => {
    const result = await markdownGenerateHandler(
      { title: "Shape Test", markdown: "# Shape" },
      CTX,
    );

    expect(result.assetId).toBe(FAKE_ASSET.id);
    expect(result.publicId).toBe(FAKE_ASSET.publicId);
    expect(result.kind).toBe("markdown");
    expect(result.mimeType).toBe("text/markdown");
    expect(result.sizeBytes).toBe(FAKE_ASSET.sizeBytes);
    expect(result.url).toBe(FAKE_ASSET.url);
    expect(result.serveUrl).toBe(FAKE_ASSET.serveUrl);
  });

  it("emits a file-attachment render directive with a url-friendly .md slug", async () => {
    const result = await markdownGenerateHandler(
      { title: "My Report", markdown: "# My Report" },
      CTX,
    );

    expect(result.render.componentId).toBe("file-attachment");
    expect(result.render.props.kind).toBe("markdown");
    // Lowercase-hyphenated slug + extension (matches the panel + download name).
    expect(result.render.props.name).toBe("my-report.md");
    expect(result.render.props.mimeType).toBe("text/markdown");
    expect(result.render.props.url).toBe(FAKE_ASSET.serveUrl);
    expect(result.render.props.sizeBytes).toBe(FAKE_ASSET.sizeBytes);
  });

  it("persists the clean title as displayName for a human-readable filename", async () => {
    await markdownGenerateHandler(
      { title: "USS Nautilus: Polar Crossing", markdown: "# x" },
      CTX,
    );
    const arg = mocks.persistGeneratedAsset.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.displayName).toBe("USS Nautilus: Polar Crossing");
  });
});

describe("markdownGenerateHandler — sections fallback", () => {
  it("assembles H1 + H2 + paragraphs when markdown is absent", async () => {
    await markdownGenerateHandler(
      {
        title: "My Doc",
        sections: [
          {
            heading: "Introduction",
            paragraphs: ["First para.", "Second para."],
          },
          { paragraphs: ["No heading."] },
        ],
      },
      CTX,
    );

    const arg = mocks.persistGeneratedAsset.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const decoded = new TextDecoder().decode(arg.bytes as Uint8Array);

    expect(decoded).toContain("# My Doc");
    expect(decoded).toContain("## Introduction");
    expect(decoded).toContain("First para.");
    expect(decoded).toContain("Second para.");
    expect(decoded).toContain("No heading.");
  });

  it("persists under the document kind with mimeType=text/markdown", async () => {
    await markdownGenerateHandler(
      {
        title: "Sections Doc",
        sections: [{ heading: "H", paragraphs: ["P"] }],
      },
      CTX,
    );

    const arg = mocks.persistGeneratedAsset.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.kind).toBe("document");
    expect(arg.mimeType).toBe("text/markdown");
  });
});

describe("markdownGenerateHandler — title-only fallback", () => {
  it("generates an H1-only document when markdown and sections are both absent", async () => {
    await markdownGenerateHandler({ title: "Minimal" }, CTX);

    const arg = mocks.persistGeneratedAsset.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const decoded = new TextDecoder().decode(arg.bytes as Uint8Array);

    expect(decoded).toBe("# Minimal");
  });
});

describe("markdownGenerateHandler — access policy", () => {
  it("persists with accessPolicy=org so teammates can view the file", async () => {
    await markdownGenerateHandler(
      { title: "Shared", markdown: "# Shared" },
      CTX,
    );

    const arg = mocks.persistGeneratedAsset.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(arg.accessPolicy).toBe("org");
  });
});

describe("markdownGenerateHandler — error paths", () => {
  it("throws when persistGeneratedAsset rejects", async () => {
    mocks.persistGeneratedAsset.mockRejectedValueOnce(
      new Error("Upload failed"),
    );

    await expect(
      markdownGenerateHandler({ title: "Fail", markdown: "# Fail" }, CTX),
    ).rejects.toThrow("Upload failed");
  });

  it("throws when userId is absent from context", async () => {
    const ctxNoUser = makeCTX({ userId: null });

    await expect(
      markdownGenerateHandler(
        { title: "No user", markdown: "# Hi" },
        ctxNoUser,
      ),
    ).rejects.toThrow("userId is required");
  });
});
