import { describe, expect, it } from "vitest";
import { documentsPdfCreate } from "./document.pdf.create";

describe("documents.pdf.create capability", () => {
  // ── Input parsing ──────────────────────────────────────────────────────────

  it("parses a minimal valid input (title only)", () => {
    const parsed = documentsPdfCreate.input.parse({ title: "Report" });
    expect(parsed.title).toBe("Report");
    expect(parsed.content).toBeUndefined();
    expect(parsed.brandColors).toBeUndefined();
  });

  it("parses a full input with sections and brandColors", () => {
    const parsed = documentsPdfCreate.input.parse({
      title: "Invoice",
      content: {
        sections: [
          { heading: "Summary", paragraphs: ["Total: $100"] },
          { paragraphs: ["Thank you for your business."] },
        ],
      },
      brandColors: { primary: "#4f46e5" },
    });
    expect(parsed.content?.sections).toHaveLength(2);
    expect(parsed.content?.sections?.[0]?.heading).toBe("Summary");
    expect(parsed.brandColors?.primary).toBe("#4f46e5");
  });

  it("rejects an empty title", () => {
    expect(() => documentsPdfCreate.input.parse({ title: "" })).toThrow();
  });

  it("rejects a section with no paragraphs", () => {
    expect(() =>
      documentsPdfCreate.input.parse({
        title: "Bad",
        content: { sections: [{ heading: "H", paragraphs: [] }] },
      }),
    ).toThrow();
  });

  // ── Output parsing ─────────────────────────────────────────────────────────

  it("parses a valid output shape", () => {
    const parsed = documentsPdfCreate.output.parse({
      assetId: "asset-pdf-uuid",
      publicId: "gen_PDFTEST",
      kind: "pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
      url: "https://blob.example.com/report.pdf",
      serveUrl: "/api/v1/assets/gen_PDFTEST",
      render: {
        componentId: "file-attachment",
        props: {
          url: "/api/v1/assets/gen_PDFTEST",
          name: "Report.pdf",
          kind: "pdf",
          mimeType: "application/pdf",
          sizeBytes: 4096,
        },
      },
    });
    expect(parsed.assetId).toBe("asset-pdf-uuid");
    expect(parsed.kind).toBe("pdf");
    expect(parsed.render.componentId).toBe("file-attachment");
    expect(parsed.render.props.name).toBe("Report.pdf");
  });

  it("rejects output missing required fields", () => {
    expect(() => documentsPdfCreate.output.parse({ assetId: "x" })).toThrow();
  });

  it("rejects output with wrong render componentId", () => {
    expect(() =>
      documentsPdfCreate.output.parse({
        assetId: "x",
        publicId: "gen_X",
        kind: "pdf",
        mimeType: "application/pdf",
        sizeBytes: 100,
        url: "https://example.com/x",
        serveUrl: "/api/v1/assets/gen_X",
        render: {
          componentId: "image-preview", // wrong
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
