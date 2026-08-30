import { describe, expect, it } from "vitest";
import { documentsGenerate } from "./document.generate";

describe("documents.generate capability", () => {
  // ── Input parsing ──────────────────────────────────────────────────────────

  it("parses a minimal valid input (kind + title)", () => {
    const parsed = documentsGenerate.input.parse({
      kind: "document",
      title: "My Doc",
    });
    expect(parsed.kind).toBe("document");
    expect(parsed.title).toBe("My Doc");
    expect(parsed.content).toBeUndefined();
    expect(parsed.brandColors).toBeUndefined();
  });

  it("parses a document input with sections", () => {
    const parsed = documentsGenerate.input.parse({
      kind: "document",
      title: "Report",
      content: {
        sections: [
          { heading: "Introduction", paragraphs: ["Hello world."] },
          { paragraphs: ["No heading here."] },
        ],
      },
    });
    expect(parsed.content?.sections).toHaveLength(2);
    expect(parsed.content?.sections?.[0]?.heading).toBe("Introduction");
  });

  it("parses a spreadsheet input with headers and rows", () => {
    const parsed = documentsGenerate.input.parse({
      kind: "spreadsheet",
      title: "Budget",
      content: {
        headers: ["Month", "Revenue"],
        rows: [
          ["Jan", 1000],
          ["Feb", 2000],
        ],
      },
    });
    expect(parsed.kind).toBe("spreadsheet");
    expect(parsed.content?.headers).toEqual(["Month", "Revenue"]);
    expect(parsed.content?.rows?.[0]).toEqual(["Jan", 1000]);
  });

  it("parses a presentation input with slides", () => {
    const parsed = documentsGenerate.input.parse({
      kind: "presentation",
      title: "Deck",
      content: {
        slides: [
          { title: "Agenda", bullets: ["Item 1", "Item 2"] },
          { title: "Summary" },
        ],
      },
    });
    expect(parsed.content?.slides?.[0]?.title).toBe("Agenda");
    expect(parsed.content?.slides?.[0]?.bullets).toHaveLength(2);
  });

  it("parses brandColors when supplied", () => {
    const parsed = documentsGenerate.input.parse({
      kind: "document",
      title: "Branded",
      brandColors: { primary: "#4f46e5", secondary: "#22c55e" },
    });
    expect(parsed.brandColors?.primary).toBe("#4f46e5");
  });

  it("rejects an empty title", () => {
    expect(() =>
      documentsGenerate.input.parse({ kind: "document", title: "" }),
    ).toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      documentsGenerate.input.parse({ kind: "notebook", title: "Test" }),
    ).toThrow();
  });

  // ── Output parsing ─────────────────────────────────────────────────────────

  it("parses a valid output shape", () => {
    const parsed = documentsGenerate.output.parse({
      assetId: "asset-uuid-123",
      publicId: "gen_ABC123",
      kind: "document",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 2048,
      url: "https://blob.example.com/doc.docx",
      serveUrl: "/api/v1/assets/gen_ABC123",
      render: {
        componentId: "file-attachment",
        props: {
          url: "/api/v1/assets/gen_ABC123",
          name: "My Doc.docx",
          kind: "document",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: 2048,
        },
      },
    });
    expect(parsed.assetId).toBe("asset-uuid-123");
    expect(parsed.publicId).toBe("gen_ABC123");
    expect(parsed.kind).toBe("document");
    expect(parsed.render.componentId).toBe("file-attachment");
    expect(parsed.render.props.name).toBe("My Doc.docx");
  });

  it("rejects output missing required fields", () => {
    expect(() => documentsGenerate.output.parse({ assetId: "x" })).toThrow();
  });

  it("rejects output with invalid kind", () => {
    expect(() =>
      documentsGenerate.output.parse({
        assetId: "x",
        publicId: "gen_X",
        kind: "pdf", // not in the enum for this contract
        mimeType: "application/pdf",
        sizeBytes: 100,
        url: "https://example.com/x",
        serveUrl: "/api/v1/assets/gen_X",
        render: {
          componentId: "file-attachment",
          props: {
            url: "/x",
            name: "x.pdf",
            kind: "pdf",
            mimeType: "application/pdf",
            sizeBytes: 100,
          },
        },
      }),
    ).toThrow();
  });
});
