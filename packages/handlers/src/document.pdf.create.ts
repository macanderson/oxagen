// documents.pdf.create.ts — real PDF generation using pdf-lib (pure JS, serverless-safe).
// No Chromium or headless browser required. Structured content (title + sections)
// is laid out in a simple single-column format with a title, headings, and body
// paragraphs. Bytes are uploaded via persistGeneratedAsset().

import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  documentsPdfCreate,
  type DocumentsPdfCreateInput,
} from "@oxagen/oxagen/contracts/document.pdf.create";
import { logger } from "./logger";
import { persistGeneratedAsset } from "./generated-asset.persist";

// ── Layout constants ──────────────────────────────────────────────────────────

const PAGE_WIDTH = 595.28; // A4 points
const PAGE_HEIGHT = 841.89;
const MARGIN = 72; // 1 inch
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const FONT_SIZE_TITLE = 24;
const FONT_SIZE_HEADING = 16;
const FONT_SIZE_BODY = 11;
const LINE_SPACING_TITLE = 36;
const LINE_SPACING_HEADING = 28;
const LINE_SPACING_BODY = 18;
const PARAGRAPH_GAP = 10;
const HEADING_GAP = 14;

// ── Naive word-wrap ────────────────────────────────────────────────────────────
// pdf-lib's standard fonts have consistent character width for the ASCII range.
// For Helvetica at a given size, character width ≈ fontSize * 0.55 is a
// reasonable approximation (avoids a full metrics lookup per char).
function wrapText(text: string, maxWidth: number, fontSize: number): string[] {
  const approxCharWidth = fontSize * 0.55;
  const maxCharsPerLine = Math.floor(maxWidth / approxCharWidth);
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// ── PDF builder ───────────────────────────────────────────────────────────────

async function buildPdf(
  title: string,
  content: DocumentsPdfCreateInput["content"],
): Promise<Uint8Array> {
  const { PDFDocument, rgb } = await import("pdf-lib");

  const pdfDoc = await PDFDocument.create();
  pdfDoc.setTitle(title);
  pdfDoc.setCreator("Oxagen");
  pdfDoc.setCreationDate(new Date());

  const font = await pdfDoc.embedFont("Helvetica");
  const boldFont = await pdfDoc.embedFont("Helvetica-Bold");

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  // Helper: draw text at current y, advancing downward. Adds a new page when
  // the y cursor would overflow the bottom margin.
  const drawLine = (
    text: string,
    size: number,
    lineSpacing: number,
    useBold = false,
    colorValue: [number, number, number] = [0, 0, 0],
  ) => {
    const textFont = useBold ? boldFont : font;
    const lines = wrapText(text, CONTENT_WIDTH, size);
    for (const line of lines) {
      if (y - lineSpacing < MARGIN) {
        page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        y = PAGE_HEIGHT - MARGIN;
      }
      y -= lineSpacing;
      page.drawText(line, {
        x: MARGIN,
        y,
        size,
        font: textFont,
        color: rgb(...colorValue),
      });
    }
  };

  // Title
  drawLine(title, FONT_SIZE_TITLE, LINE_SPACING_TITLE, true, [0.1, 0.1, 0.1]);
  y -= HEADING_GAP;

  // Body sections
  const sections = content?.sections ?? [];
  for (const section of sections) {
    if (section.heading) {
      y -= HEADING_GAP;
      drawLine(
        section.heading,
        FONT_SIZE_HEADING,
        LINE_SPACING_HEADING,
        true,
        [0.2, 0.2, 0.8],
      );
      y -= 4;
    }
    for (const para of section.paragraphs) {
      drawLine(para, FONT_SIZE_BODY, LINE_SPACING_BODY, false);
      y -= PARAGRAPH_GAP;
    }
  }

  const bytes = await pdfDoc.save();
  return bytes;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const documentsPdfCreateHandler: CapabilityHandler<
  typeof documentsPdfCreate
> = async (input, ctx) => {
  if (!ctx.userId) {
    throw new Error(
      "documents.pdf.create: userId is required — no user identity in context",
    );
  }

  const { title, content } = input;
  const mimeType = "application/pdf";

  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, title },
    "documents.pdf.create: starting",
  );

  let bytes: Uint8Array;
  try {
    bytes = await buildPdf(title, content);
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, title },
      "documents.pdf.create: pdf-lib encoding failed",
    );
    throw err;
  }

  const userId = ctx.userId; // narrowed to string by the guard above
  const asset = await persistGeneratedAsset({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId,
    kind: "pdf",
    mimeType,
    bytes,
    prompt: `Generate PDF: ${title}`,
    model: "local",
    messageId: ctx.messageId ?? undefined,
    accessPolicy: "org",
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      publicId: asset.publicId,
      sizeBytes: asset.sizeBytes,
    },
    "documents.pdf.create: complete",
  );

  return {
    assetId: asset.id,
    publicId: asset.publicId,
    kind: "pdf",
    mimeType,
    sizeBytes: asset.sizeBytes,
    url: asset.url,
    serveUrl: asset.serveUrl,
    render: {
      componentId: "file-attachment",
      props: {
        url: asset.serveUrl,
        name: `${title}.pdf`,
        kind: "pdf",
        mimeType,
        sizeBytes: asset.sizeBytes,
      },
    },
  };
};
