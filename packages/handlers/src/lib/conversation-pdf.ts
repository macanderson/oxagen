// conversation-pdf.ts — formatted PDF rendering for conversation.export.
//
// Pure pdf-lib layout (serverless-safe, no Chromium) over the same normalized
// ConversationExportModel the Markdown serializer uses, so both formats stay
// in lockstep. Design goals: a proper cover/title block, per-message role
// accents, real word-wrapping measured against the embedded font metrics,
// monospace code/tool blocks on light-gray rounded panels, and page footers
// with page numbers — long conversations paginate cleanly without text ever
// running through the footer.

import type {
  PDFFont,
  PDFPage,
  PDFDocument as PDFDocumentType,
  RGB,
} from "pdf-lib";
import type {
  ConversationExportModel,
  ExportBlock,
} from "./conversation-markdown";
import { formatDuration, roleLabel } from "./conversation-markdown";

// ── Page geometry (A4) ────────────────────────────────────────────────────────

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
// Content never descends below the top margin band; the footer sits beneath at
// y≈30, so body text can never collide with it.
const CONTENT_BOTTOM = MARGIN;
const FOOTER_Y = 30;

// ── Type scale ────────────────────────────────────────────────────────────────

const TITLE_SIZE = 22;
const TITLE_LEADING = 28;
const META_SIZE = 10;
const META_LEADING = 15;
const ROLE_SIZE = 10;
const BODY_SIZE = 10.5;
const BODY_LEADING = 15;
const CODE_SIZE = 8.5;
const CODE_LEADING = 12;
const CODE_PADDING = 8;
const FOOTER_SIZE = 8;
const MESSAGE_GAP = 20;
const BLOCK_GAP = 8;

// ── Palette ───────────────────────────────────────────────────────────────────

type Rgb = [number, number, number];
const INK: Rgb = [0.12, 0.12, 0.14];
const MUTED: Rgb = [0.45, 0.45, 0.5];
const RULE: Rgb = [0.85, 0.86, 0.88];
const USER_ACCENT: Rgb = [0.13, 0.38, 0.92];
const ASSISTANT_ACCENT: Rgb = [0.45, 0.29, 0.85];
const OTHER_ACCENT: Rgb = [0.35, 0.35, 0.4];
const CODE_BG: Rgb = [0.955, 0.957, 0.965];
const CODE_BORDER: Rgb = [0.88, 0.89, 0.91];

function accentFor(role: string): Rgb {
  if (role === "user") return USER_ACCENT;
  if (role === "assistant") return ASSISTANT_ACCENT;
  return OTHER_ACCENT;
}

// ── WinAnsi sanitization ──────────────────────────────────────────────────────
//
// pdf-lib's standard fonts encode WinAnsi only; unencodable codepoints (emoji,
// CJK, box-drawing) would throw at draw time. Map common typographic characters
// to safe equivalents, then strip the remainder.

const CHAR_MAP: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "…": "...",
  "•": "*",
  "→": "->",
  "←": "<-",
  " ": " ",
  "❤": "<3",
};

export function sanitizePdfText(text: string): string {
  let out = text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  out = out.replace(/[‘’“”–—…•→← ❤]/g, (c) => CHAR_MAP[c] ?? "");
  // Strip everything outside printable ASCII + Latin-1 (keep \n for splitting).
  return out.replace(/[^\n\x20-\x7E¡-ÿ]/g, "");
}

// ── Word wrap (measured, not approximated) ────────────────────────────────────

/** Wrap a single logical line to maxWidth using real font metrics; words longer
 *  than a line are hard-broken by characters so nothing overflows the panel. */
export function wrapLine(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  const width = (s: string) => font.widthOfTextAtSize(s, size);

  const pushWordChunks = (word: string) => {
    // Hard-break an over-long word.
    let chunk = "";
    for (const ch of word) {
      if (width(chunk + ch) > maxWidth && chunk) {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    return chunk;
  };

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (width(candidate) <= maxWidth) {
      current = candidate;
    } else if (current) {
      lines.push(current);
      current = width(word) > maxWidth ? pushWordChunks(word) : word;
    } else {
      current = pushWordChunks(word);
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

/** Wrap multi-line text: split on newlines, wrap each logical line. */
function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  return text
    .split("\n")
    .flatMap((line) => wrapLine(line, font, size, maxWidth));
}

// ── Rounded rect (SVG path — pdf-lib rectangles have square corners) ──────────

function roundedRectPath(w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h / 2);
  return (
    `M ${rr},0 L ${w - rr},0 Q ${w},0 ${w},${rr} L ${w},${h - rr} ` +
    `Q ${w},${h} ${w - rr},${h} L ${rr},${h} Q 0,${h} 0,${h - rr} ` +
    `L 0,${rr} Q 0,0 ${rr},0 Z`
  );
}

// ── Renderer ──────────────────────────────────────────────────────────────────

interface Cursor {
  page: PDFPage;
  y: number;
}

export async function buildConversationPdf(
  model: ConversationExportModel,
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");

  const doc = await PDFDocument.create();
  doc.setTitle(model.title);
  doc.setCreator("Oxagen");
  doc.setCreationDate(model.exportedAt);

  const body = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const mono = await doc.embedFont(StandardFonts.Courier);

  const color = (c: Rgb): RGB => rgb(c[0], c[1], c[2]);

  const cur: Cursor = {
    page: doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    y: PAGE_HEIGHT - MARGIN,
  };

  const newPage = () => {
    cur.page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    cur.y = PAGE_HEIGHT - MARGIN;
  };

  /** Ensure at least `needed` points of vertical space remain on the page. */
  const ensure = (needed: number) => {
    if (cur.y - needed < CONTENT_BOTTOM) newPage();
  };

  const drawLines = (
    lines: string[],
    font: PDFFont,
    size: number,
    leading: number,
    c: Rgb,
    x = MARGIN,
  ) => {
    for (const line of lines) {
      ensure(leading);
      cur.y -= leading;
      if (line.length > 0) {
        cur.page.drawText(line, { x, y: cur.y, size, font, color: color(c) });
      }
    }
  };

  const drawParagraph = (
    text: string,
    font: PDFFont,
    size: number,
    leading: number,
    c: Rgb,
    x = MARGIN,
    width = CONTENT_WIDTH,
  ) => {
    drawLines(
      wrapText(sanitizePdfText(text), font, size, width),
      font,
      size,
      leading,
      c,
      x,
    );
  };

  /** Monospace panel (code / tool summaries): light-gray rounded rect behind
   *  Courier lines, chunked across pages so a long block paginates cleanly. */
  const drawMonoPanel = (text: string, c: Rgb = INK) => {
    const inner = CONTENT_WIDTH - CODE_PADDING * 2;
    let lines = wrapText(sanitizePdfText(text), mono, CODE_SIZE, inner);
    while (lines.length > 0) {
      // If not even one line + padding fits, start a fresh page.
      ensure(CODE_LEADING + CODE_PADDING * 2);
      const available = cur.y - CONTENT_BOTTOM - CODE_PADDING * 2;
      const fit = Math.max(
        1,
        Math.min(lines.length, Math.floor(available / CODE_LEADING)),
      );
      const chunk = lines.slice(0, fit);
      lines = lines.slice(fit);
      const panelH = chunk.length * CODE_LEADING + CODE_PADDING * 2;
      cur.page.drawSvgPath(roundedRectPath(CONTENT_WIDTH, panelH, 6), {
        x: MARGIN,
        y: cur.y,
        color: color(CODE_BG),
        borderColor: color(CODE_BORDER),
        borderWidth: 0.75,
      });
      cur.y -= CODE_PADDING;
      drawLines(chunk, mono, CODE_SIZE, CODE_LEADING, c, MARGIN + CODE_PADDING);
      cur.y -= CODE_PADDING;
      if (lines.length > 0) newPage();
    }
  };

  // ── Cover / title block ─────────────────────────────────────────────────────

  cur.page.drawSvgPath(roundedRectPath(64, 6, 3), {
    x: MARGIN,
    y: cur.y,
    color: color(ASSISTANT_ACCENT),
  });
  cur.y -= 18;
  drawParagraph(model.title, bold, TITLE_SIZE, TITLE_LEADING, INK);
  cur.y -= 6;

  const scope = [model.orgName, model.workspaceName]
    .filter(Boolean)
    .join(" / ");
  const metaLines = [
    `Exported ${model.exportedAt.toISOString().slice(0, 10)}  ·  Created ${model.createdAt.toISOString().slice(0, 10)}`,
    ...(scope ? [scope] : []),
    `${model.messages.length} message${model.messages.length === 1 ? "" : "s"}${
      model.totalMessageCount > model.messages.length
        ? `  ·  active branch of ${model.totalMessageCount}`
        : ""
    }`,
  ];
  for (const line of metaLines)
    drawParagraph(line, body, META_SIZE, META_LEADING, MUTED);

  cur.y -= 10;
  ensure(2);
  cur.page.drawLine({
    start: { x: MARGIN, y: cur.y },
    end: { x: PAGE_WIDTH - MARGIN, y: cur.y },
    thickness: 1,
    color: color(RULE),
  });

  const drawBlock = (block: ExportBlock): void => {
    switch (block.kind) {
      case "text":
        drawParagraph(block.text, body, BODY_SIZE, BODY_LEADING, INK);
        break;
      case "reasoning": {
        const duration = formatDuration(block.durationMs);
        drawParagraph(
          duration ? `Reasoning (${duration})` : "Reasoning",
          italic,
          META_SIZE,
          META_LEADING,
          MUTED,
        );
        drawParagraph(
          block.text,
          italic,
          META_SIZE,
          META_LEADING,
          MUTED,
          MARGIN + 12,
          CONTENT_WIDTH - 12,
        );
        break;
      }
      case "tool": {
        const duration = formatDuration(block.durationMs);
        const summary = [
          `tool: ${block.capability}`,
          `status: ${block.status}`,
          ...(duration ? [`duration: ${duration}`] : []),
        ].join("  ·  ");
        const text = block.resultPreview
          ? `${summary}\nresult: ${block.resultPreview}`
          : summary;
        drawMonoPanel(text, MUTED);
        break;
      }
      case "code":
        drawMonoPanel(
          block.language ? `[${block.language}]\n${block.code}` : block.code,
        );
        break;
      case "attachment":
        drawParagraph(
          `Attachment: ${block.name} — ${block.url}`,
          body,
          META_SIZE,
          META_LEADING,
          USER_ACCENT,
        );
        break;
    }
  };

  // ── Messages ────────────────────────────────────────────────────────────────

  for (const message of model.messages) {
    cur.y -= MESSAGE_GAP;
    // Keep the role header and at least one body line together.
    ensure(ROLE_SIZE + BODY_LEADING * 2);

    const accent = accentFor(message.role);
    const label = sanitizePdfText(roleLabel(message.role)).toUpperCase();
    cur.y -= ROLE_SIZE + 2;
    cur.page.drawText(label, {
      x: MARGIN,
      y: cur.y,
      size: ROLE_SIZE,
      font: bold,
      color: color(accent),
    });
    // Accent underline bar beneath the role label.
    cur.y -= 5;
    cur.page.drawSvgPath(roundedRectPath(22, 2.5, 1.25), {
      x: MARGIN,
      y: cur.y,
      color: color(accent),
    });
    cur.y -= 4;

    for (const block of message.blocks) {
      cur.y -= BLOCK_GAP;
      drawBlock(block);
    }
  }

  // ── Footers (after layout so the total page count is known) ────────────────

  drawFooters(doc, body, color(MUTED));

  return doc.save();
}

function drawFooters(
  doc: PDFDocumentType,
  font: PDFFont,
  footerColor: RGB,
): void {
  const pages = doc.getPages();
  const total = pages.length;
  pages.forEach((page, i) => {
    page.drawText("Exported from Oxagen", {
      x: MARGIN,
      y: FOOTER_Y,
      size: FOOTER_SIZE,
      font,
      color: footerColor,
    });
    const label = `Page ${i + 1} of ${total}`;
    const w = font.widthOfTextAtSize(label, FOOTER_SIZE);
    page.drawText(label, {
      x: PAGE_WIDTH - MARGIN - w,
      y: FOOTER_Y,
      size: FOOTER_SIZE,
      font,
      color: footerColor,
    });
  });
}
