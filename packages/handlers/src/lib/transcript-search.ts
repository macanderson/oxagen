// Searching a run's transcript on the server (#3942, ADR-182).
//
// The Run page used to search the rows it had drawn, in the browser, over
// text it had assembled itself. The search runs here now, over the folded
// entries a read returns, so every surface searches the same entries by the
// same rule: an entry matches when its label, its tool, its target, or the
// text of either half holds the query, ignoring case.
//
// Label, tool and target are on the entry. The halves' text is in the
// evidence store, one read per half, and a run can keep a body for every
// frame. So an entry that matched on its label, tool or target is not read
// at all: it matched, and reading its halves would only say where else. The
// search reads at most `halfMax` halves of the other entries, in entry order,
// and counts every half it could not look inside: one kept only as a digest,
// one the store could not answer or that no longer hashes, and one past the
// bound. A half that carried no content has nothing to search and is not
// counted.
//
// An entry the fold or `markWords` marked `quiet` draws no row, so the search
// skips it: it cannot match, it reads no half and it spends none of the bound.
// A match is one a reader can see, and `matched` counts only rows a reader is
// shown.
import type {
  TranscriptEntryBody,
  TranscriptMatch,
  TranscriptSearchView,
} from "@oxagen/oxagen/contracts/run.transcript.get";
import type { RunFrame, TranscriptFold } from "@oxagen/run-ledger";
import { mapConcurrent } from "./map-concurrent";

/**
 * The words a half shows a reader, as one string: its text, or for a half
 * that carries an assembly, what the model said and thought, each tool it
 * called with its input, and each result's summary. Null when the half
 * carries neither, because its body was not kept or could not be read.
 */
export function searchableText(body: TranscriptEntryBody): string | null {
  if (body.text !== null) return body.text;
  if (body.assembly === null) return null;
  return body.assembly.blocks
    .map((block) => {
      switch (block.kind) {
        case "text":
        case "thinking":
          return block.text;
        case "tool_use":
          return `${block.name}\n${
            typeof block.input === "string"
              ? block.input
              : (JSON.stringify(block.input) ?? "")
          }`;
        case "tool_result":
          return block.summary;
      }
    })
    .join("\n");
}

type Slot = "request" | "response";

export interface TranscriptSearchResult {
  /** The entries that matched, in the order given. */
  folds: TranscriptFold[];
  /** Where each matching entry matched. */
  matches: Map<TranscriptFold, TranscriptMatch[]>;
  search: TranscriptSearchView;
}

/**
 * The entries of `folds` that hold `query`, and where. `readText` answers a
 * half's searchable text, or null when it cannot be read. An entry that
 * matched on its label, tool or target has no half read, so its matches name
 * only those. A `quiet` entry is not searched at all.
 */
export async function searchFolds(
  folds: readonly TranscriptFold[],
  query: string,
  readText: (frame: RunFrame) => Promise<string | null>,
  limits: { halfMax: number; concurrency: number },
): Promise<TranscriptSearchResult> {
  const needle = query.trim().toLowerCase();
  const holds = (text: string | null | undefined) =>
    typeof text === "string" && text.toLowerCase().includes(needle);

  // What each entry matched on itself, with no body read.
  const onEntry = new Map<TranscriptFold, TranscriptMatch[]>();
  const shown = folds.filter((fold) => !fold.quiet);
  for (const fold of shown) {
    const where: TranscriptMatch[] = [];
    if (holds(fold.opening.summary)) where.push("label");
    if (holds(fold.subject)) where.push("subject");
    if (holds(fold.opening.identity.target)) where.push("target");
    if (where.length > 0) onEntry.set(fold, where);
  }

  let unsearched = 0;
  let budget = limits.halfMax;
  const reads: { fold: TranscriptFold; slot: Slot; frame: RunFrame }[] = [];
  for (const fold of shown) {
    if (onEntry.has(fold)) continue;
    for (const slot of ["request", "response"] as const) {
      const frame = fold[slot];
      if (frame === null || frame.body.bodyDigest === null) continue;
      if (frame.body.bodyRef === null || budget === 0) {
        unsearched += 1;
        continue;
      }
      budget -= 1;
      reads.push({ fold, slot, frame });
    }
  }
  // Each worker keeps only whether the half held the query, so a search
  // over thousands of halves never holds their text at once.
  const found = await mapConcurrent(reads, limits.concurrency, async (read) => {
    const text = await readText(read.frame);
    return text === null ? null : holds(text);
  });
  const inHalves = new Map<TranscriptFold, Set<Slot>>();
  found.forEach((hit, i) => {
    if (hit === null) unsearched += 1;
    if (hit !== true) return;
    const read = reads[i] as (typeof reads)[number];
    const slots = inHalves.get(read.fold) ?? new Set<Slot>();
    slots.add(read.slot);
    inHalves.set(read.fold, slots);
  });

  const matched: TranscriptFold[] = [];
  const matches = new Map<TranscriptFold, TranscriptMatch[]>();
  for (const fold of shown) {
    const where: TranscriptMatch[] = [...(onEntry.get(fold) ?? [])];
    const slots = inHalves.get(fold);
    if (slots?.has("request")) where.push("request");
    if (slots?.has("response")) where.push("response");
    if (where.length === 0) continue;
    matched.push(fold);
    matches.set(fold, where);
  }
  return {
    folds: matched,
    matches,
    search: { query: needle, matched: matched.length, unsearched },
  };
}
