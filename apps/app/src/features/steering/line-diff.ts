// The line diff the Context PR page draws from a file's two sides (#5077).
// A record file is a few dozen lines, so the longest common subsequence over
// lines is exact and cheap. Past LINE_DIFF_MAX_CELLS the table that finds it
// would cost too much memory in a request, so the diff says every line was
// removed and added rather than guess an alignment.

/** One line of the diff: kept, removed from the base, or added on the head. */
export type DiffLine = {
  kind: "same" | "removed" | "added";
  text: string;
  /** The line's number on the base side; null for an added line. */
  before: number | null;
  /** The line's number on the head side; null for a removed line. */
  after: number | null;
};

/** The largest before × after line product the exact diff computes. */
export const LINE_DIFF_MAX_CELLS = 4_000_000;

/** A file's text as its lines, with no empty line for the final newline. */
function linesOf(text: string | null): string[] {
  if (text === null || text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The lines `before` and `after` share, kept, with the removals and additions between them. */
export function lineDiff(
  before: string | null,
  after: string | null,
): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  const out: DiffLine[] = [];
  if (a.length * b.length > LINE_DIFF_MAX_CELLS) {
    a.forEach((text, i) =>
      out.push({ kind: "removed", text, before: i + 1, after: null }),
    );
    b.forEach((text, j) =>
      out.push({ kind: "added", text, before: null, after: j + 1 }),
    );
    return out;
  }
  // lcs[i][j]: the common lines of a[i..] and b[j..], in one flat array.
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              lcs[(i + 1) * width + j] ?? 0,
              lcs[i * width + j + 1] ?? 0,
            );
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] ?? "", before: i + 1, after: j + 1 });
      i += 1;
      j += 1;
    } else if (
      (lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)
    ) {
      out.push({ kind: "removed", text: a[i] ?? "", before: i + 1, after: null });
      i += 1;
    } else {
      out.push({ kind: "added", text: b[j] ?? "", before: null, after: j + 1 });
      j += 1;
    }
  }
  for (; i < a.length; i += 1)
    out.push({ kind: "removed", text: a[i] ?? "", before: i + 1, after: null });
  for (; j < b.length; j += 1)
    out.push({ kind: "added", text: b[j] ?? "", before: null, after: j + 1 });
  return out;
}
