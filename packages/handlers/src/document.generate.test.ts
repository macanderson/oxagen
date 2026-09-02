/**
 * documents.generate handler tests.
 *
 * Strategy: mock `persistGeneratedAsset` at the module level so no real blob
 * upload or DB insert occurs. Mock the file-format encoders (docx, exceljs,
 * pptxgenjs) to return fixed bytes matching each format's ZIP-based magic
 * header (OOXML documents are ZIP containers → PK\x03\x04). Assert:
 *   - the encoder is called with the right content
 *   - persistGeneratedAsset is called with the right kind/mimeType
 *   - the output shape matches the contract (assetId, publicId, kind,
 *     mimeType, sizeBytes, url, serveUrl, render directive)
 *   - the render directive carries `file-attachment` with the correct props
 *   - error paths throw correctly
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── ZIP magic header shared by all OOXML formats (docx/xlsx/pptx) ─────────────
const PK_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // PK\x03\x04

// ── Fake asset returned by persistGeneratedAsset ──────────────────────────────
const FAKE_ASSET = {
  id: "asset-uuid-123",
  publicId: "gen_DOCTEST",
  kind: "document" as const,
  mimeType:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  sizeBytes: 1024,
  url: "https://blob.example.com/doc.docx",
  serveUrl: "/api/v1/assets/gen_DOCTEST",
};

// ── Hoisted mocks (must be declared before any imports that use them) ─────────
const mocks = vi.hoisted(() => ({
  persistGeneratedAsset: vi.fn(),
  // docx: Packer.toBuffer returns a Node.js Buffer
  docxPackerToBuffer: vi.fn(),
  // exceljs: workbook.xlsx.writeBuffer
  excelWriteBuffer: vi.fn(),
  // pptxgenjs: pres.write
  pptxWrite: vi.fn(),
}));

vi.mock("./generated-asset.persist", () => ({
  persistGeneratedAsset: mocks.persistGeneratedAsset,
}));

// Mock the docx library. The handler imports it via dynamic import("docx").
vi.mock("docx", () => {
  // Paragraph and TextRun are classes; HeadingLevel is an enum-like object.
  class FakeParagraph {
    constructor(_opts: unknown) {}
  }
  class FakeTextRun {
    constructor(_opts: unknown) {}
  }
  class FakeDocument {
    constructor(_opts: unknown) {}
  }
  const FakePacker = {
    toBuffer: mocks.docxPackerToBuffer,
  };
  const HeadingLevel = { TITLE: "TITLE", HEADING_1: "HEADING_1" };
  return {
    Document: FakeDocument,
    Packer: FakePacker,
    Paragraph: FakeParagraph,
    TextRun: FakeTextRun,
    HeadingLevel,
  };
});

// Mock exceljs. The package is CJS and exports Workbook as a named export
// (no default). The handler does `const { Workbook } = await import("exceljs")`.
vi.mock("exceljs", () => {
  class FakeWorksheet {
    addRow(_data: unknown) {
      return {
        eachCell: (_cb: (cell: { font?: unknown }) => void) => {
          _cb({ font: {} });
        },
      };
    }
  }
  class FakeWorkbook {
    creator = "";
    created: Date = new Date();
    xlsx = { writeBuffer: mocks.excelWriteBuffer };
    addWorksheet(_name: string) {
      return new FakeWorksheet();
    }
  }
  return { Workbook: FakeWorkbook };
});

// Mock pptxgenjs
vi.mock("pptxgenjs", () => {
  class FakeSlide {
    addText(_content: unknown, _opts?: unknown) {}
  }
  class FakePres {
    addSlide() {
      return new FakeSlide();
    }
    write(_opts: { outputType: string }) {
      return mocks.pptxWrite();
    }
  }
  return { default: FakePres };
});

// ── Import handler after mocks ────────────────────────────────────────────────
import { documentsGenerateHandler } from "./document.generate";
import type { CapabilityContext } from "@oxagen/oxagen";

import { TEST_CTX as CTX } from "./test-utils/fixtures";

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Packer.toBuffer returns a Node.js Buffer; use a Uint8Array with PK magic.
  const fakeDocxBytes = new Uint8Array([...PK_MAGIC, ...new Uint8Array(60)]);
  mocks.docxPackerToBuffer.mockResolvedValue(Buffer.from(fakeDocxBytes));

  // Excel buffer — PK magic (xlsx is also a ZIP)
  const fakeXlsxBuffer = new Uint8Array([...PK_MAGIC, ...new Uint8Array(60)]);
  mocks.excelWriteBuffer.mockResolvedValue(fakeXlsxBuffer.buffer);

  // PPTX returns base64; btoa(PK bytes) would be "UEsD..." — we fake something
  // decodeable. Use a PK prefix encoded as base64.
  const pkBase64 = btoa(String.fromCharCode(...PK_MAGIC) + "\x00".repeat(60));
  mocks.pptxWrite.mockResolvedValue(pkBase64);

  mocks.persistGeneratedAsset.mockResolvedValue(FAKE_ASSET);
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("documentsGenerateHandler — document (DOCX)", () => {
  it("calls docx Packer.toBlob and persists with kind=document", async () => {
    await documentsGenerateHandler(
      {
        kind: "document",
        title: "My Report",
        content: {
          sections: [{ heading: "Introduction", paragraphs: ["Hello world."] }],
        },
      },
      CTX,
    );

    expect(mocks.docxPackerToBuffer).toHaveBeenCalledTimes(1);
    expect(mocks.persistGeneratedAsset).toHaveBeenCalledTimes(1);

    const persistArg = mocks.persistGeneratedAsset.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(persistArg.kind).toBe("document");
    expect(persistArg.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(persistArg.bytes).toBeInstanceOf(Uint8Array);
    // Assert the PK magic header (DOCX is a ZIP container).
    const bytes = persistArg.bytes as Uint8Array;
    expect(bytes[0]).toBe(0x50); // P
    expect(bytes[1]).toBe(0x4b); // K
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);
  });

  it("output shape matches contract", async () => {
    const result = await documentsGenerateHandler(
      { kind: "document", title: "Shape Test" },
      CTX,
    );

    expect(result.assetId).toBe(FAKE_ASSET.id);
    expect(result.publicId).toBe(FAKE_ASSET.publicId);
    expect(result.kind).toBe("document");
    expect(result.mimeType).toContain("wordprocessingml");
    expect(result.sizeBytes).toBe(FAKE_ASSET.sizeBytes);
    expect(result.url).toBe(FAKE_ASSET.url);
    expect(result.serveUrl).toBe(FAKE_ASSET.serveUrl);
  });

  it("emits a file-attachment render directive with correct props", async () => {
    const result = await documentsGenerateHandler(
      { kind: "document", title: "Render Test" },
      CTX,
    );

    expect(result.render.componentId).toBe("file-attachment");
    expect(result.render.props.kind).toBe("document");
    expect(result.render.props.name).toBe("Render Test.docx");
    expect(result.render.props.url).toBe(FAKE_ASSET.serveUrl);
    expect(result.render.props.mimeType).toContain("wordprocessingml");
    expect(result.render.props.sizeBytes).toBe(FAKE_ASSET.sizeBytes);
  });

  it("works with no content (fallback to title-only)", async () => {
    await expect(
      documentsGenerateHandler({ kind: "document", title: "Minimal" }, CTX),
    ).resolves.not.toThrow();
  });

  it("throws when persistGeneratedAsset rejects", async () => {
    mocks.persistGeneratedAsset.mockRejectedValueOnce(
      new Error("Upload failed"),
    );
    await expect(
      documentsGenerateHandler({ kind: "document", title: "Fail" }, CTX),
    ).rejects.toThrow("Upload failed");
  });
});

describe("documentsGenerateHandler — spreadsheet (XLSX)", () => {
  it("calls exceljs writeBuffer and persists with kind=spreadsheet", async () => {
    await documentsGenerateHandler(
      {
        kind: "spreadsheet",
        title: "Sales Data",
        content: {
          headers: ["Month", "Revenue"],
          rows: [
            ["Jan", 1000],
            ["Feb", 2000],
          ],
        },
      },
      CTX,
    );

    expect(mocks.excelWriteBuffer).toHaveBeenCalledTimes(1);
    const persistArg = mocks.persistGeneratedAsset.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(persistArg.kind).toBe("spreadsheet");
    expect(persistArg.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    const bytes = persistArg.bytes as Uint8Array;
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it("emits render directive with .xlsx extension", async () => {
    const result = await documentsGenerateHandler(
      { kind: "spreadsheet", title: "My Sheet" },
      CTX,
    );
    expect(result.render.props.name).toBe("My Sheet.xlsx");
    expect(result.render.props.kind).toBe("spreadsheet");
  });
});

describe("documentsGenerateHandler — presentation (PPTX)", () => {
  it("calls pptxgenjs write and persists with kind=presentation", async () => {
    await documentsGenerateHandler(
      {
        kind: "presentation",
        title: "Q1 Deck",
        content: {
          slides: [
            { title: "Agenda", bullets: ["Intro", "Revenue", "Wrap-up"] },
          ],
        },
      },
      CTX,
    );

    expect(mocks.pptxWrite).toHaveBeenCalledTimes(1);
    const persistArg = mocks.persistGeneratedAsset.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(persistArg.kind).toBe("presentation");
    expect(persistArg.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );

    const bytes = persistArg.bytes as Uint8Array;
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it("emits render directive with .pptx extension", async () => {
    const result = await documentsGenerateHandler(
      { kind: "presentation", title: "Slides" },
      CTX,
    );
    expect(result.render.props.name).toBe("Slides.pptx");
    expect(result.render.props.kind).toBe("presentation");
  });
});

describe("documentsGenerateHandler — org access policy", () => {
  it("persists with accessPolicy=org so teammates can view the file", async () => {
    await documentsGenerateHandler({ kind: "document", title: "Shared" }, CTX);
    const persistArg = mocks.persistGeneratedAsset.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(persistArg.accessPolicy).toBe("org");
  });
});
