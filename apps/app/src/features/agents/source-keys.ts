// The source editor's edits that a key makes rather than a character (spec
// pages/agent-source.md, the key hints: Tab indent, ⇧Tab outdent, ⌘/
// comment), and the find count. Pure functions over the text and the
// selection, so the editor applies the answer and a test reads it without a
// DOM. Two spaces is the indent, as the status line says.

export type Edit = { value: string; start: number; end: number };

const INDENT = "  ";

/** The offsets of the first and the one-past-last character of the lines the selection touches. */
function lineSpan(value: string, start: number, end: number) {
  const from = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const stop = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const next = value.indexOf("\n", stop);
  return {
    from: start === 0 ? 0 : from,
    to: next === -1 ? value.length : next,
  };
}

/** Tab: two spaces at the caret, or before every line a selection spans. */
export function indent(value: string, start: number, end: number): Edit {
  if (start === end) {
    return {
      value: value.slice(0, start) + INDENT + value.slice(end),
      start: start + INDENT.length,
      end: start + INDENT.length,
    };
  }
  const { from, to } = lineSpan(value, start, end);
  const lines = value.slice(from, to).split("\n");
  const block = lines.map((line) => INDENT + line).join("\n");
  return {
    value: value.slice(0, from) + block + value.slice(to),
    start: start + INDENT.length,
    end: end + INDENT.length * lines.length,
  };
}

/** ⇧Tab: up to two leading spaces off every line the selection touches. */
export function outdent(value: string, start: number, end: number): Edit {
  const { from, to } = lineSpan(value, start, end);
  const lines = value.slice(from, to).split("\n");
  let removedFirst = 0;
  let removed = 0;
  const block = lines
    .map((line, index) => {
      const cut = line.startsWith(INDENT) ? 2 : line.startsWith(" ") ? 1 : 0;
      if (index === 0) removedFirst = cut;
      removed += cut;
      return line.slice(cut);
    })
    .join("\n");
  return {
    value: value.slice(0, from) + block + value.slice(to),
    start: Math.max(from, start - removedFirst),
    end: Math.max(from, end - removed),
  };
}

/** ⌘/: comment every non-blank line the selection touches with `# `, or uncomment them when all already are. */
export function toggleComment(value: string, start: number, end: number): Edit {
  const { from, to } = lineSpan(value, start, end);
  const lines = value.slice(from, to).split("\n");
  const commented = lines.every(
    (line) => line.trim() === "" || /^\s*#/.test(line),
  );
  const block = lines
    .map((line) => {
      if (line.trim() === "") return line;
      return commented
        ? line.replace(/^(\s*)#\s?/, "$1")
        : line.replace(/^(\s*)/, "$1# ");
    })
    .join("\n");
  return {
    value: value.slice(0, from) + block + value.slice(to),
    start: from,
    end: from + block.length,
  };
}

/** Every offset the query starts at, case-insensitive; none for an empty query. */
export function findAll(value: string, query: string): number[] {
  if (query === "") return [];
  const hay = value.toLowerCase();
  const needle = query.toLowerCase();
  const found: number[] = [];
  let at = hay.indexOf(needle);
  while (at !== -1) {
    found.push(at);
    at = hay.indexOf(needle, at + needle.length);
  }
  return found;
}

/** The 1-based line and column of an offset, for the status line. */
export function lineCol(value: string, offset: number) {
  const before = value.slice(0, offset).split("\n");
  return { line: before.length, col: (before.at(-1) ?? "").length + 1 };
}
