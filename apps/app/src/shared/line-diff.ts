// How far a draft has moved from the file it started from, in lines: the lines
// a unified diff would mark added and removed, from the longest common
// subsequence. A definition file is tens of lines, so the quadratic table is
// two rows of it. Pure and edge-safe.

export type DiffStat = { added: number; removed: number };

export function diffStat(base: string, draft: string): DiffStat {
  const a = base.split("\n");
  const b = draft.split("\n");
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = a.length - 1; i >= 0; i--) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = b.length - 1; j >= 0; j--) {
      row[j] =
        a[i] === b[j]
          ? (previous[j + 1] ?? 0) + 1
          : Math.max(previous[j] ?? 0, row[j + 1] ?? 0);
    }
    previous = row;
  }
  const common = previous[0] ?? 0;
  return { added: b.length - common, removed: a.length - common };
}
