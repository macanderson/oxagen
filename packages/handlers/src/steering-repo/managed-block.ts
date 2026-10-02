// steering-repo/managed-block.ts: put the production branch's managed block
// back in a file a steering PR changed (restore_managed_block, #4518).
//
// AGENTS.md, CLAUDE.md, and README.md hold Oxagen's text between two marker
// lines, and the `owned` check fails a steering PR that changes it. Its fix
// says to restore the block from the production branch. This does that and
// keeps every line outside the block:
//
// - A file the PR deleted comes back as the production branch holds it.
// - A block the PR edited is replaced, in place, by the production block.
// - A block the PR removed goes back at the top of the file.
// - Broken markers (a second block, a begin with no end) are taken out, with
//   the text between a begin marker and the end marker after it, and the
//   production block goes where the first of them was.
import {
  MANAGED_BLOCK_END,
  readManagedBlock,
} from "@oxagen/oxagen/steering-repo/templates";

/** The start of every begin marker; the hash follows it. */
const BEGIN_PREFIX = "<!-- oxagen:begin managed sha256:";

export type ManagedBlockRestore =
  /** The production branch's file holds no readable block, so there is nothing to restore from. */
  | { kind: "no_block" }
  /** The block at the head is the production block already. */
  | { kind: "intact" }
  | { kind: "restored"; text: string };

/** The head's lines with every marker, and each begin's text up to its end, taken out. */
function withoutMarkers(lines: readonly string[]): { kept: string[]; at: number } {
  const kept: string[] = [];
  let at = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.startsWith(BEGIN_PREFIX)) {
      if (at < 0) at = kept.length;
      const end = lines.indexOf(MANAGED_BLOCK_END, i + 1);
      const next = lines.findIndex((l, j) => j > i && l.startsWith(BEGIN_PREFIX));
      // A begin with its end before the next begin takes its text with it.
      // A begin with no end of its own goes alone, so no note below it is lost.
      if (end > i && (next < 0 || end < next)) i = end;
      continue;
    }
    if (line === MANAGED_BLOCK_END) {
      if (at < 0) at = kept.length;
      continue;
    }
    kept.push(line);
  }
  return { kept, at: at < 0 ? 0 : at };
}

/**
 * The head's file with the production branch's block restored, or why
 * nothing is written. `head` is null when the PR deleted the file.
 */
export function restoreManagedBlock(
  production: string | null,
  head: string | null,
): ManagedBlockRestore {
  if (production === null) return { kind: "no_block" };
  const source = readManagedBlock(production);
  if (!source.ok || source.block === null) return { kind: "no_block" };
  const block = source.block;
  const productionLines = production.split("\n");
  const blockLines = productionLines.slice(block.begin_line - 1, block.end_line);

  if (head === null) return { kind: "restored", text: production };
  const lines = head.split("\n");
  const current = readManagedBlock(head);
  if (current.ok && current.block !== null) {
    if (current.block.intact && current.block.content === block.content)
      return { kind: "intact" };
    lines.splice(
      current.block.begin_line - 1,
      current.block.end_line - current.block.begin_line + 1,
      ...blockLines,
    );
    return { kind: "restored", text: lines.join("\n") };
  }
  if (current.ok) {
    // The PR removed the block. It goes back at the top, a blank line above
    // whatever the file holds now.
    const rest = head.trim() === "" ? [""] : ["", ...lines];
    return { kind: "restored", text: [...blockLines, ...rest].join("\n") };
  }
  const { kept, at } = withoutMarkers(lines);
  kept.splice(at, 0, ...blockLines);
  return { kind: "restored", text: kept.join("\n") };
}
