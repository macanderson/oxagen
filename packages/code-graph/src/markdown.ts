/**
 * Markdown / MDX documentation parser.
 *
 * Splits a document into heading-delimited sections so each section becomes an
 * embeddable local symbol (kind "heading"). A section runs from its ATX heading
 * line up to (but not including) the next heading of the SAME OR HIGHER level, so
 * nested subsections fall inside their parent's range as well as standing on their
 * own. The first H1 (or first heading) is returned as the document title.
 *
 * Deliberately dependency-free: a line scan is robust enough for headings and
 * avoids pulling a markdown AST library into the runtime. Fenced code blocks are
 * tracked so a `#` inside ``` ``` ``` is not mistaken for a heading.
 *
 * Module: @oxagen/code-graph/markdown
 * This parser is part of the checkout-local graph implementation.
 */

import type { ParsedSymbol } from "./types";

const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^(```|~~~)/;

export interface MarkdownParse {
  title?: string;
  symbols: ParsedSymbol[];
}

export function parseMarkdown(content: string): MarkdownParse {
  const lines = content.split("\n");

  // First pass: locate every heading (level, text, row), skipping fenced blocks.
  const headings: Array<{ level: number; text: string; row: number }> = [];
  let inFence = false;
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]!;
    if (FENCE.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = ATX_HEADING.exec(line);
    if (m) {
      headings.push({ level: m[1]!.length, text: m[2]!.trim(), row });
    }
  }

  const symbols: ParsedSymbol[] = headings.map((h, i) => {
    // The section ends just before the next heading of the same or higher level
    // (lower number = higher level), or at EOF.
    let endRow = lines.length - 1;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j]!.level <= h.level) {
        endRow = headings[j]!.row - 1;
        break;
      }
    }
    const sectionLines = lines.slice(h.row, endRow + 1);
    const code = sectionLines.join("\n").trim();
    // The body blurb (section text minus the heading line) feeds docComment.
    const blurb = sectionLines.slice(1).join("\n").trim();
    return {
      name: h.text,
      kind: "heading" as const,
      startLine: h.row,
      endLine: endRow,
      signature: `${"#".repeat(h.level)} ${h.text}`,
      ...(blurb ? { docComment: blurb.slice(0, 1000) } : {}),
      ...(code ? { code } : {}),
    };
  });

  const title = headings.find((h) => h.level === 1)?.text ?? headings[0]?.text;

  return { ...(title ? { title } : {}), symbols };
}
