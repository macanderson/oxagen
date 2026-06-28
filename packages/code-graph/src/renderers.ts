/**
 * Pure embedding-text renderers for source files and symbols.
 *
 * These are PURE string builders — no I/O, no AI calls. They render a
 * ParsedSymbol or a file's metadata into the text string that will be sent to
 * the embedding model. The AI embed call itself stays in the consumers
 * (packages/ingestion for the platform, apps/cli for local search).
 *
 * Module: @oxagen/code-graph/renderers
 * Moved from packages/ingestion/src/embed/index.ts — canonical location is
 * now here; ingestion re-exports for backward compat.
 */

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
