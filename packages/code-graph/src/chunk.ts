/**
 * Text chunking for full-content embedding.
 *
 * A file's body is split into overlapping windows so large files are fully
 * searchable by content (not just by symbol name). Splitting prefers line
 * boundaries so a chunk rarely cuts mid-statement, and consecutive chunks overlap
 * by a few hundred characters so a match that straddles a boundary is still found.
 *
 * Counts are bounded: at most MAX_CHUNKS per file. When a file exceeds that, the
 * caller is told via the returned `truncated` flag so the cap is never silent.
 *
 * Module: @oxagen/code-graph/chunk
 * Chunk text remains checkout-local and is never a workspace-graph payload.
 */

export interface TextChunk {
  /** 0-based position of this chunk within the file. */
  index: number;
  /** The chunk's text. */
  text: string;
  /** 0-indexed first source line covered by the chunk. */
  startLine: number;
  /** 0-indexed last source line covered by the chunk. */
  endLine: number;
}

export interface ChunkOptions {
  /** Target maximum characters per chunk. */
  maxChars?: number;
  /** Characters of overlap between consecutive chunks. */
  overlapChars?: number;
  /** Hard cap on the number of chunks produced for one file. */
  maxChunks?: number;
}

export interface ChunkResult {
  chunks: TextChunk[];
  /** True when the file produced more than `maxChunks` windows and was capped. */
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_OVERLAP_CHARS = 200;
const DEFAULT_MAX_CHUNKS = 40;

/**
 * Split `text` into overlapping, line-aligned chunks.
 *
 * The algorithm accumulates whole lines until adding the next line would exceed
 * `maxChars`, emits the chunk, then rewinds by `overlapChars` worth of trailing
 * lines so the next chunk overlaps. Empty input yields no chunks.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): ChunkResult {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const overlapChars = opts.overlapChars ?? DEFAULT_OVERLAP_CHARS;
  const maxChunks = opts.maxChunks ?? DEFAULT_MAX_CHUNKS;

  if (text.trim().length === 0) return { chunks: [], truncated: false };

  const lines = text.split("\n");
  const chunks: TextChunk[] = [];

  let startLine = 0;
  while (startLine < lines.length) {
    let endLine = startLine;
    let size = 0;
    // Grow the window line-by-line up to maxChars (always take at least one line).
    while (endLine < lines.length) {
      const lineLen = lines[endLine]!.length + 1; // +1 for the newline
      if (size + lineLen > maxChars && endLine > startLine) break;
      size += lineLen;
      endLine++;
    }
    const sliceLines = lines.slice(startLine, endLine);
    const chunkText_ = sliceLines.join("\n").trim();
    if (chunkText_.length > 0) {
      chunks.push({
        index: chunks.length,
        text: chunkText_,
        startLine,
        endLine: endLine - 1,
      });
      if (chunks.length >= maxChunks) {
        return { chunks, truncated: endLine < lines.length };
      }
    }
    if (endLine >= lines.length) break;
    // Rewind by ~overlapChars worth of lines so the next window overlaps.
    let rewind = 0;
    let rewound = endLine;
    while (rewound > startLine + 1 && rewind < overlapChars) {
      rewound--;
      rewind += lines[rewound]!.length + 1;
    }
    startLine = Math.max(rewound, startLine + 1);
  }

  return { chunks, truncated: false };
}
