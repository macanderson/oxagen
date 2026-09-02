import { describe, expect, it } from "vitest";
import { archiveCreate } from "./archive.create";

describe("archive.create capability", () => {
  // ── Input parsing ──────────────────────────────────────────────────────────

  it("parses a minimal valid input with a text entry", () => {
    const parsed = archiveCreate.input.parse({
      archiveName: "my-bundle",
      entries: [{ name: "readme.txt", text: "Hello!" }],
    });
    expect(parsed.archiveName).toBe("my-bundle");
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.name).toBe("readme.txt");
    expect(parsed.entries[0]?.text).toBe("Hello!");
  });

  it("parses an entry with assetId", () => {
    const parsed = archiveCreate.input.parse({
      archiveName: "assets",
      entries: [{ name: "doc.docx", assetId: "gen_ABC123" }],
    });
    expect(parsed.entries[0]?.assetId).toBe("gen_ABC123");
  });

  it("parses an entry with contentBase64", () => {
    const parsed = archiveCreate.input.parse({
      archiveName: "blob-arch",
      entries: [{ name: "data.bin", contentBase64: "AAAA" }],
    });
    expect(parsed.entries[0]?.contentBase64).toBe("AAAA");
  });

  it("parses multiple entries", () => {
    const parsed = archiveCreate.input.parse({
      archiveName: "multi",
      entries: [
        { name: "a.txt", text: "A" },
        { name: "b.txt", text: "B" },
        { name: "c.bin", contentBase64: "AAAA" },
      ],
    });
    expect(parsed.entries).toHaveLength(3);
  });

  it("defaults archiveName to 'archive'", () => {
    const parsed = archiveCreate.input.parse({
      entries: [{ name: "x.txt", text: "x" }],
    });
    expect(parsed.archiveName).toBe("archive");
  });

  it("rejects empty entries array", () => {
    expect(() =>
      archiveCreate.input.parse({ archiveName: "empty", entries: [] }),
    ).toThrow();
  });

  it("rejects an entry with an empty name", () => {
    expect(() =>
      archiveCreate.input.parse({
        archiveName: "bad",
        entries: [{ name: "", text: "x" }],
      }),
    ).toThrow();
  });

  // ── Output parsing ─────────────────────────────────────────────────────────

  it("parses a valid output shape", () => {
    const parsed = archiveCreate.output.parse({
      assetId: "asset-uuid-arch",
      publicId: "gen_ZIPTEST",
      kind: "archive",
      mimeType: "application/zip",
      sizeBytes: 512,
      url: "https://blob.example.com/archive.zip",
      serveUrl: "/api/v1/assets/gen_ZIPTEST",
      render: {
        componentId: "file-attachment",
        props: {
          url: "/api/v1/assets/gen_ZIPTEST",
          name: "bundle.zip",
          kind: "archive",
          mimeType: "application/zip",
          sizeBytes: 512,
        },
      },
    });
    expect(parsed.kind).toBe("archive");
    expect(parsed.mimeType).toBe("application/zip");
    expect(parsed.render.componentId).toBe("file-attachment");
    expect(parsed.render.props.kind).toBe("archive");
    expect(parsed.render.props.name).toBe("bundle.zip");
  });

  it("rejects output missing required fields", () => {
    expect(() => archiveCreate.output.parse({ assetId: "x" })).toThrow();
  });

  it("rejects output with wrong kind", () => {
    expect(() =>
      archiveCreate.output.parse({
        assetId: "x",
        publicId: "gen_X",
        kind: "document", // wrong kind for archive output
        mimeType: "application/zip",
        sizeBytes: 100,
        url: "https://example.com/x",
        serveUrl: "/api/v1/assets/gen_X",
        render: {
          componentId: "file-attachment",
          props: {
            url: "/x",
            name: "x.zip",
            kind: "archive",
            mimeType: "application/zip",
            sizeBytes: 100,
          },
        },
      }),
    ).toThrow();
  });
});

describe("archive.create entries capacity guard", () => {
  it("rejects more than 100 entries (memory/event-loop DoS guard)", () => {
    const entries = Array.from({ length: 101 }, (_, i) => ({
      name: `f${i}.txt`,
      text: "x",
    }));
    expect(() => archiveCreate.input.parse({ entries })).toThrow(
      /at most 100/i,
    );
  });

  it("accepts exactly 100 entries", () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      name: `f${i}.txt`,
      text: "x",
    }));
    expect(archiveCreate.input.parse({ entries }).entries).toHaveLength(100);
  });
});
