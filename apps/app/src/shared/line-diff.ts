// How far one text has moved from another, in lines.
//
// `diffStat` answers the count alone — the lines a unified diff would mark
// added and removed — for the agent definition editor, which shows a draft's
// distance from the committed file and nothing more. It keeps two rows of the
// table rather than the whole of it, because that is all a count needs.
//
// `buildDiff` answers the diff itself, for the transcript, which has to draw
// the change an edit made rather than state its size.
//
// A line diff, so an edit reads as the change it made rather than as two
// bodies of text a reader has to compare by eye.
//
// The transcript records an edit as the string that was there and the string
// that replaced it. Nothing in the record is a diff, so the diff is computed
// here, at the surface, from the two halves the record kept. It is a view of
// the evidence and never a substitute for it: the whole of both halves stays
// one disclosure away.
//
// Pure, bounded and edge-safe. The table is O(a x b), so a pair larger than
// `MAX_CELLS` is reported as a wholesale replacement rather than hung on.

export type DiffStat = { added: number; removed: number };

/**
 * The lines a unified diff would mark added and removed, and nothing else.
 * Two rows of the table, because a count never needs the whole of it.
 */
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

/**
 * What happened to one line.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export type DiffOp = "add" | "del" | "ctx";

export type DiffLine = {
  op: DiffOp;
  text: string;
  /** The line's number in the old text; null for an addition. */
  before: number | null;
  /** The line's number in the new text; null for a deletion. */
  after: number | null;
};

/**
 * One run of changed lines with its context either side.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export type DiffHunk = {
  /** The first line the hunk covers, 1-based, in each text. */
  beforeStart: number;
  afterStart: number;
  lines: DiffLine[];
};

export type LineDiff = {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /**
   * True when the texts were too large to compare line by line, so the diff
   * is the whole of one replaced by the whole of the other. The surface says
   * so rather than presenting a guess as a measurement.
   */
  wholesale: boolean;
};

/** Above this many cells the table is not built. 4 MB of booleans is the ceiling. */
const MAX_CELLS = 2_000_000;
/**
 * Unchanged lines kept either side of a change, as `diff -U3` keeps them.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export const DIFF_CONTEXT = 3;

function lines(text: string): string[] {
  if (text === "") return [];
  return text.split("\n");
}

/**
 * The length of the longest common subsequence of every prefix pair, as the
 * classic table. Row-major and `Uint32Array`-backed so a few thousand lines
 * stays one allocation rather than thousands of small arrays.
 */
function lcsTable(a: readonly string[], b: readonly string[]): Uint32Array {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(
              table[(i + 1) * width + j] ?? 0,
              table[i * width + j + 1] ?? 0,
            );
    }
  }
  return table;
}

/**
 * Every line of both texts, in order, each marked with what happened to it.
 *
 * @internal Exported for its unit test; nothing outside this module imports it.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = lines(before);
  const b = lines(after);
  const out: DiffLine[] = [];
  const width = b.length + 1;
  const table = lcsTable(a, b);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "ctx", text: a[i] ?? "", before: i + 1, after: j + 1 });
      i += 1;
      j += 1;
      continue;
    }
    // Prefer the deletion when dropping the old line keeps at least as much
    // of the common subsequence; the tie goes to deletion so a replacement
    // reads as "- old" then "+ new", the order a diff is read in.
    if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      out.push({ op: "del", text: a[i] ?? "", before: i + 1, after: null });
      i += 1;
    } else {
      out.push({ op: "add", text: b[j] ?? "", before: null, after: j + 1 });
      j += 1;
    }
  }
  while (i < a.length) {
    out.push({ op: "del", text: a[i] ?? "", before: i + 1, after: null });
    i += 1;
  }
  while (j < b.length) {
    out.push({ op: "add", text: b[j] ?? "", before: null, after: j + 1 });
    j += 1;
  }
  return out;
}

/** Every line of both texts as one wholesale replacement, with no comparison. */
function wholesaleLines(before: string, after: string): DiffLine[] {
  return [
    ...lines(before).map<DiffLine>((text, index) => ({
      op: "del",
      text,
      before: index + 1,
      after: null,
    })),
    ...lines(after).map<DiffLine>((text, index) => ({
      op: "add",
      text,
      before: null,
      after: index + 1,
    })),
  ];
}

/**
 * The change from `before` to `after`, as hunks with `DIFF_CONTEXT` unchanged
 * lines around each run of changes. Unchanged stretches longer than twice the
 * context are dropped, which is what keeps a one-line edit to a large file
 * readable.
 */
export function buildDiff(before: string, after: string): LineDiff {
  const a = lines(before);
  const b = lines(after);
  const wholesale = (a.length + 1) * (b.length + 1) > MAX_CELLS;
  const all = wholesale
    ? wholesaleLines(before, after)
    : diffLines(before, after);

  // Which indices sit near a change, and so survive into a hunk.
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((line, index) => {
    if (line.op === "ctx") return;
    const from = Math.max(0, index - DIFF_CONTEXT);
    const to = Math.min(all.length - 1, index + DIFF_CONTEXT);
    for (let k = from; k <= to; k += 1) keep[k] = true;
  });

  const hunks: DiffHunk[] = [];
  let current: DiffLine[] = [];
  const close = () => {
    if (current.length === 0) return;
    // The hunk's first line carries only one of the two numbers — an addition
    // has no old line and a deletion has no new one — so each start is the
    // first line in the hunk that has that number at all.
    const firstOf = (side: "before" | "after"): number =>
      current.find((line) => line[side] !== null)?.[side] ?? 1;
    hunks.push({
      beforeStart: firstOf("before"),
      afterStart: firstOf("after"),
      lines: current,
    });
    current = [];
  };
  all.forEach((line, index) => {
    if (keep[index] === true) current.push(line);
    else close();
  });
  close();

  return {
    hunks,
    added: all.filter((line) => line.op === "add").length,
    removed: all.filter((line) => line.op === "del").length,
    wholesale,
  };
}
