/**
 * documents.pdf.create handler tests.
 *
 * Strategy: mock persistGeneratedAsset so no real blob/DB IO occurs. Mock
 * pdf-lib to return bytes starting with the `%PDF` magic header. Assert:
 *   - the output shape matches the contract
 *   - persistGeneratedAsset called with kind=pdf and mimeType=application/pdf
 *   - bytes start with the PDF magic header (%PDF → 0x25 0x50 0x44 0x46)
 *   - render directive is file-attachment with a .pdf filename
 *   - error paths propagate correctly
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// PDF magic: %PDF-1.4 header bytes
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF

const FAKE_ASSET = {
  id: "asset-uuid-pdf",
  publicId: "gen_PDFTEST",
  kind: "pdf" as const,
  mimeType: "application/pdf",
  sizeBytes: 2048,
  url: "https://blob.example.com/report.pdf",
  serveUrl: "/api/v1/assets/gen_PDFTEST",
};

const mocks = vi.hoisted(() => ({
  persistGeneratedAsset: vi.fn(),
  pdfDocCreate: vi.fn(),
  pdfDocSave: vi.fn(),
  pdfDocEmbedFont: vi.fn(),
  pdfDocAddPage: vi.fn(),
  pageDrawText: vi.fn(),
}));

vi.mock("./generated-asset.persist", () => ({
  persistGeneratedAsset: mocks.persistGeneratedAsset,
}));

// Mock pdf-lib's dynamic import.
vi.mock("pdf-lib", () => {
  class FakePage {
    drawText(_text: string, _opts: unknown) {
      mocks.pageDrawText(_text, _opts);
    }
  }

  const fakeFont = {};

  class FakePDFDocument {
    static async create() {
      return new FakePDFDocument();
    }
    setTitle(_t: string) {}
    setCreator(_c: string) {}
    setCreationDate(_d: Date) {}
    async embedFont(_name: string) {
      return fakeFont;
    }
    addPage(_dims: unknown) {
      return new FakePage();
    }
    async save() {
      return mocks.pdfDocSave();
    }
  }

  const rgb = (r: number, g: number, b: number) => ({ r, g, b });

  return { PDFDocument: FakePDFDocument, rgb };
});

import { documentsPdfCreateHandler } from "./document.pdf.create";
import type { CapabilityContext } from "@oxagen/oxagen";

import { TEST_CTX as CTX } from "./test-utils/fixtures";

beforeEach(() => {
  vi.clearAllMocks();

  // pdf-lib's save() returns a Uint8Array starting with %PDF
  const fakePdfBytes = new Uint8Array([...PDF_MAGIC, ...new Uint8Array(100)]);
  mocks.pdfDocSave.mockResolvedValue(fakePdfBytes);

  mocks.persistGeneratedAsset.mockResolvedValue(FAKE_ASSET);
});

describe("documentsPdfCreateHandler", () => {
  it("calls pdf-lib and persists with kind=pdf and correct mimeType", async () => {
    await documentsPdfCreateHandler(
      {
        title: "Annual Report",
        content: {
          sections: [
            {
              heading: "Executive Summary",
              paragraphs: [
                "Results were positive.",
                "Growth exceeded targets.",
              ],
            },
          ],
        },
      },
      CTX,
    );

    expect(mocks.pdfDocSave).toHaveBeenCalledTimes(1);
    expect(mocks.persistGeneratedAsset).toHaveBeenCalledTimes(1);

    const persistArg = mocks.persistGeneratedAsset.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(persistArg.kind).toBe("pdf");
    expect(persistArg.mimeType).toBe("application/pdf");

    // Assert PDF magic header.
    const bytes = persistArg.bytes as Uint8Array;
    expect(bytes[0]).toBe(0x25); // %
    expect(bytes[1]).toBe(0x50); // P
    expect(bytes[2]).toBe(0x44); // D
    expect(bytes[3]).toBe(0x46); // F
  });

  it("output shape matches contract", async () => {
    const result = await documentsPdfCreateHandler(
      { title: "Shape Report" },
      CTX,
    );

    expect(result.assetId).toBe(FAKE_ASSET.id);
    expect(result.publicId).toBe(FAKE_ASSET.publicId);
    expect(result.kind).toBe("pdf");
    expect(result.mimeType).toBe("application/pdf");
    expect(result.sizeBytes).toBe(FAKE_ASSET.sizeBytes);
    expect(result.url).toBe(FAKE_ASSET.url);
    expect(result.serveUrl).toBe(FAKE_ASSET.serveUrl);
  });

  it("emits a file-attachment render directive with .pdf filename", async () => {
    const result = await documentsPdfCreateHandler({ title: "My Report" }, CTX);

    expect(result.render.componentId).toBe("file-attachment");
    expect(result.render.props.kind).toBe("pdf");
    expect(result.render.props.name).toBe("My Report.pdf");
    expect(result.render.props.url).toBe(FAKE_ASSET.serveUrl);
    expect(result.render.props.mimeType).toBe("application/pdf");
    expect(result.render.props.sizeBytes).toBe(FAKE_ASSET.sizeBytes);
  });

  it("works with minimal input (title only, no content)", async () => {
    await expect(
      documentsPdfCreateHandler({ title: "Minimal PDF" }, CTX),
    ).resolves.not.toThrow();
  });

  it("works with multi-section content", async () => {
    await expect(
      documentsPdfCreateHandler(
        {
          title: "Multi Section",
          content: {
            sections: [
              { heading: "Chapter 1", paragraphs: ["First paragraph."] },
              { paragraphs: ["Paragraph without heading."] },
              {
                heading: "Chapter 3",
                paragraphs: ["Alpha.", "Beta.", "Gamma."],
              },
            ],
          },
        },
        CTX,
      ),
    ).resolves.not.toThrow();
  });

  it("persists with accessPolicy=org", async () => {
    await documentsPdfCreateHandler({ title: "Shared PDF" }, CTX);
    const persistArg = mocks.persistGeneratedAsset.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(persistArg.accessPolicy).toBe("org");
  });

  it("throws when persistGeneratedAsset rejects", async () => {
    mocks.persistGeneratedAsset.mockRejectedValueOnce(
      new Error("blob write failure"),
    );
    await expect(
      documentsPdfCreateHandler({ title: "Fail" }, CTX),
    ).rejects.toThrow("blob write failure");
  });

  it("throws when pdf-lib save rejects", async () => {
    mocks.pdfDocSave.mockRejectedValueOnce(new Error("pdf encoding error"));
    await expect(
      documentsPdfCreateHandler({ title: "BadPdf" }, CTX),
    ).rejects.toThrow("pdf encoding error");
  });
});
