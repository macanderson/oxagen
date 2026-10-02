// code-repo-check/statements.ts: the statements a pull request adds to one
// instruction file.
//
// A statement is one list item or one paragraph of Markdown, with its wrapped
// lines joined. Headings, code blocks, tables, HTML comments, and a rule
// file's frontmatter are not statements: they carry no instruction an agent
// acts on by itself.
//
// Both hosts can read a file at two refs, and only GitHub returns a patch, so
// the added lines come from the two texts: each head line that the base text
// does not hold as often is added. A statement is added when any of its lines
// is, so an edit to one word of a paragraph makes the whole paragraph new.

/** One statement a pull request adds to an instruction file. */
export interface AddedStatement {
  /** The instruction file's path in the repository. */
  path: string;
  /** The head line the statement starts on, counted from 1. */
  line: number;
  /** The statement's text, its lines joined by spaces, without a list marker. */
  text: string;
}

/** A statement shorter than this many words is a label, such as "Rules:". */
export const STATEMENT_MIN_WORDS = 3;
/** The longest statement compared. A longer block is cut here. */
export const STATEMENT_MAX_CHARS = 4000;

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/;
const QUOTE_MARKER = /^\s*>\s?/;
const THEMATIC_BREAK = /^\s{0,3}(?:[-*_]\s*){3,}$/;

/** The words a statement holds, as the steering conflicts check counts them. */
export function wordCount(text: string): number {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return words === "" ? 0 : words.split(" ").length;
}

/** The index of every head line the base text does not hold as often. */
function addedLineIndexes(base: string | null, head: readonly string[]): Set<number> {
  const remaining = new Map<string, number>();
  for (const line of base === null ? [] : base.split(/\r?\n/)) {
    const key = line.trim();
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const added = new Set<number>();
  head.forEach((line, index) => {
    const key = line.trim();
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else added.add(index);
  });
  return added;
}

interface Block {
  start: number;
  indexes: number[];
  parts: string[];
  /** True for a block quote, which a plain line does not continue. */
  quote: boolean;
}

/** Every list item and paragraph of a Markdown text, with the lines each spans. */
function blocksOf(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let current: Block | null = null;
  let inFence = false;
  let inComment = false;
  let index = 0;
  const close = () => {
    if (current !== null) blocks.push(current);
    current = null;
  };
  // A rule file's frontmatter (Cursor's .mdc, Copilot's .instructions.md)
  // holds settings, such as globs, not instructions.
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (end > 0) index = end + 1;
  }
  for (; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    if (inFence) {
      if (FENCE.test(raw)) inFence = false;
      continue;
    }
    if (inComment) {
      if (raw.includes("-->")) inComment = false;
      continue;
    }
    if (FENCE.test(raw)) {
      close();
      inFence = true;
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.startsWith("<!--")) {
      close();
      if (!trimmed.includes("-->")) inComment = true;
      continue;
    }
    const quoted = QUOTE_MARKER.test(trimmed);
    const text = trimmed.replace(QUOTE_MARKER, "").trim();
    // A block quote starts its own block, as it interrupts a paragraph in
    // Markdown, and a plain line after one starts the next.
    if (current !== null && current.quote !== quoted) close();
    if (
      text === "" ||
      HEADING.test(text) ||
      THEMATIC_BREAK.test(text) ||
      text.startsWith("|")
    ) {
      close();
      continue;
    }
    if (LIST_MARKER.test(text)) {
      close();
      current = {
        start: index,
        indexes: [index],
        parts: [text.replace(LIST_MARKER, "").trim()],
        quote: quoted,
      };
      continue;
    }
    if (current === null)
      current = { start: index, indexes: [], parts: [], quote: quoted };
    const block: Block = current;
    block.indexes.push(index);
    block.parts.push(text);
  }
  close();
  return blocks;
}

/**
 * The statements the head text of `path` adds against its base text. A file
 * the pull request creates has a null base, so every statement in it is
 * added.
 */
export function addedStatements(
  path: string,
  base: string | null,
  head: string,
): AddedStatement[] {
  const lines = head.split(/\r?\n/);
  const added = addedLineIndexes(base, lines);
  const statements: AddedStatement[] = [];
  for (const block of blocksOf(lines)) {
    if (!block.indexes.some((index) => added.has(index))) continue;
    const text = block.parts.join(" ").replace(/\s+/g, " ").trim();
    if (wordCount(text) < STATEMENT_MIN_WORDS) continue;
    statements.push({
      path,
      line: block.start + 1,
      text: text.slice(0, STATEMENT_MAX_CHARS),
    });
  }
  return statements;
}
