// A transcript read to its end. The Run page reads it at `steps` with whole
// bodies for the Transcript tab, and at `everything` for the tabs that list
// frames (Governed actions, Policy, Context). Every page carries the whole
// run's counts and figures, counted on the server (ADR-182), so the read
// answers the last page's, which are the most recent.
//
// `get_run_transcript` answers one page of entries and a cursor. The tabs
// used to take the first page and call it the run, and they said the list
// was cut only when `complete` was false, which means the run passed the
// read's frame cap and not that another page was waiting. A run with more
// than one page of policy decisions showed the first page as the whole list.
// Here the page reads page after page, up to a bound, and `isWhole` says
// whether what it holds is the whole run.
import {
  type RunTranscript,
  TRANSCRIPT_ENTRY_MAX,
  type TranscriptKind,
  type TranscriptText,
  type TranscriptZoom,
} from "@/data/contracts/run";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { mergeEntries } from "./transcript-rows";

/**
 * The most pages one read makes. At the largest page the contract allows,
 * that is its frame cap (10,000), so a run the read can fold at all is read to
 * its end, and a run past it stops here and says so.
 *
 * Every page re-reads and re-folds the run on the server, so the page size is
 * what the whole read costs. At the default 200 entries a page, a
 * 25,000-frame run took 50 reads and 7.1 seconds; at 500 it takes 20 reads and
 * 2.8 seconds (#4067, the benchmark in run.transcript.get.bench.test.ts).
 */
const WHOLE_TRANSCRIPT_PAGES = 10_000 / TRANSCRIPT_ENTRY_MAX;

/**
 * Whether a transcript holds the whole run: the read folded every frame
 * (`complete`) and no page lies past the last one read (`cursor === null`).
 * A live run always carries a resume cursor, so it reads as not whole, which
 * is true: it is still recording.
 */
export function isWhole(transcript: RunTranscript): boolean {
  return transcript.complete && transcript.cursor === null;
}

/**
 * `get_run_transcript` at `zoom`, narrowed to `kinds` and carrying `text` of
 * each body, read page by page until the run is read or
 * `WHOLE_TRANSCRIPT_PAGES` pages have been. The entries are every page's, in
 * order, each once: a page that sends again an entry an earlier page held
 * (one that grew between the two reads of a live run) replaces it where it
 * stands (`mergeEntries`). The cursor is the last page's: null when the run
 * was read to its end, and otherwise the point the list stops at, so
 * `isWhole` says it is a prefix. A page that fails after the first keeps what
 * was read and its cursor, so the tab says the list stops short rather than
 * failing a list it mostly holds.
 *
 * `frameCursor` is where a live reader's stream opens. Every page answers the
 * head of the run's fold, so a read that stopped short of it (a failed page,
 * or the page bound with more to read) answers none: the stream then opens at
 * the run's first frame, and its signals page the missing entries in.
 */
export async function readWholeTranscript(
  // Only the transcript read: a caller hands in its whole source, and a test
  // hands in the one method this reads.
  source: { runs: Pick<DataSource["runs"], "transcript"> },
  ctx: WsCtx,
  runId: string,
  zoom: TranscriptZoom,
  {
    kinds = [],
    text,
  }: { kinds?: TranscriptKind[]; text?: TranscriptText } = {},
): Promise<Read<RunTranscript>> {
  const limit = TRANSCRIPT_ENTRY_MAX;
  const asked = { kinds, limit, ...(text === undefined ? {} : { text }) };
  const first = await source.runs.transcript(ctx, runId, zoom, asked);
  if (!first.ok) return first;
  let entries = [...first.value.entries];
  let last = first.value;
  for (
    let pages = 1;
    pages < WHOLE_TRANSCRIPT_PAGES &&
    last.cursor !== null &&
    // A short page is the end of what the run holds now. A live run still
    // answers a cursor there, to resume from when it records more.
    last.entries.length >= limit;
    pages += 1
  ) {
    const next = await source.runs.transcript(ctx, runId, zoom, {
      ...asked,
      after: last.cursor,
    });
    if (!next.ok) break;
    entries = mergeEntries(entries, next.value.entries);
    last = next.value;
  }
  // A full page with a cursor is a page the loop did not follow: it failed
  // or hit the bound. A live run's short last page is the head.
  const short = last.cursor !== null && last.entries.length >= limit;
  return {
    ok: true,
    value: {
      ...last,
      entries,
      complete: first.value.complete && last.complete,
      ...(short ? { frameCursor: null } : {}),
    },
  };
}
