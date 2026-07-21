/**
 * Pure embedding-text renderers for source files and symbols.
 *
 * These are PURE string builders — no I/O, no AI calls. They render a
 * ParsedSymbol or a file's metadata into the text string that will be sent to
 * the embedding model. The AI embed call itself stays in the local consumer.
 *
 * Module: @oxagen/code-graph/renderers
 * These renderers feed the checkout-local graph only.
 */

import { chunkText } from "./chunk";
import type { ParsedSymbol } from "./types";

/**
 * Build the embedding text for a whole source file: its path/language, the
 * document title or leading symbol names for orientation, and the head of the
 * actual content. Embedding real content (not just the path + symbol names) is
 * what makes "find the code that does X" work.
 */
export function renderFileText(args: {
  path: string;
  language: string;
  content: string;
  title?: string;
  symbolNames?: string[];
}): string {
  const head = args.content.slice(0, 1500);
  return [
    args.path,
    args.language,
    args.title ?? "",
    (args.symbolNames ?? []).slice(0, 40).join(" "),
    head,
  ]
    .filter((p) => p.length > 0)
    .join("\n");
}

/** Chunk granularity for {@link renderMarkdownFileText} — a handful of these
 *  windows, not one giant slice, make up the embedded text. */
const MARKDOWN_CHUNK_CHARS = 1200;

/**
 * Total character budget for a markdown file's embed text. Larger than
 * {@link renderFileText}'s 1500-char code head: a doc has no signature/import
 * list to lean on, so the prose itself has to carry the signal.
 */
const MARKDOWN_MAX_CHARS = 6000;

/**
 * Build the embedding text for a markdown/MDX file's full content.
 *
 * `renderFileText`'s blind `content.slice(0, 1500)` is right for code — the top
 * of a file (imports, exports, signatures) is its most information-dense part —
 * but a doc's important content can live anywhere: front-matter or a table of
 * contents at the top would otherwise crowd out the actual prose. This instead
 * samples sequential `chunkText()` windows (line-aligned, overlap-stitched)
 * until `maxChars` is spent, so a several-thousand-word doc contributes more
 * than its first paragraph without embedding the whole file unbounded.
 */
export function renderMarkdownFileText(args: {
  path: string;
  content: string;
  title?: string;
  maxChars?: number;
}): string {
  const cap = args.maxChars ?? MARKDOWN_MAX_CHARS;
  const { chunks } = chunkText(args.content, {
    maxChars: MARKDOWN_CHUNK_CHARS,
  });

  const picked: string[] = [];
  let used = 0;
  for (const chunk of chunks) {
    // Always take at least the first chunk, even if it alone exceeds the cap
    // (the final slice() below is the safety net for that case).
    if (picked.length > 0 && used + chunk.text.length > cap) break;
    picked.push(chunk.text);
    used += chunk.text.length;
    if (used >= cap) break;
  }

  const body = picked.join("\n\n").slice(0, cap);
  return [args.path, args.title ?? "", body]
    .filter((p) => p.length > 0)
    .join("\n");
}

/**
 * Build the embedding text for a single symbol (function/class/method/heading):
 * its kind + name + signature + leading doc comment + the code slice itself, so a
 * natural-language query like "function that retries on 5xx" matches the body.
 */
export function renderSymbolText(symbol: ParsedSymbol, path: string): string {
  return [
    `${symbol.kind} ${symbol.name}`,
    path,
    symbol.signature ?? "",
    symbol.docComment ?? "",
    symbol.code ?? "",
  ]
    .filter((p) => p.length > 0)
    .join("\n");
}
