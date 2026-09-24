// A transcript read to its end. The Run page reads it once, at `everything`,
// and everything that lists or counts across the whole run reads that one
// read: the stat row, the Transcript feed, Policy, Context and the Cost tab.
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
  TRANSCRIPT_ENTRY_DEFAULT,
  type TranscriptKind,
  type TranscriptZoom,
} from "@/data/contracts/run";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";

/**
 * The most pages one tab reads. At the default page size that is the
 * contract's frame cap (10,000), so a run the read can fold at all is read to
 * its end, and a run past it stops here and says so.
 */
const WHOLE_TRANSCRIPT_PAGES = 50;

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
 * `get_run_transcript` at `zoom`, narrowed to `kinds`, read page by page until
 * the run is read or `WHOLE_TRANSCRIPT_PAGES` pages have been. The entries
 * are every page's, in order. The cursor is the last page's: null when the
 * run was read to its end, and otherwise the point the list stops at, so
 * `isWhole` says it is a prefix. A page that fails after the first keeps what
 * was read and its cursor, so the tab says the list stops short rather than
 * failing a list it mostly holds.
 */
export async function readWholeTranscript(
  // Only the transcript read: a caller hands in its whole source, and a test
  // hands in the one method this reads.
  source: { runs: Pick<DataSource["runs"], "transcript"> },
  ctx: WsCtx,
  runId: string,
  zoom: TranscriptZoom,
  kinds: TranscriptKind[] = [],
): Promise<Read<RunTranscript>> {
  const first = await source.runs.transcript(ctx, runId, zoom, { kinds });
  if (!first.ok) return first;
  const entries = [...first.value.entries];
  let last = first.value;
  for (
    let pages = 1;
    pages < WHOLE_TRANSCRIPT_PAGES &&
    last.cursor !== null &&
    // A short page is the end of what the run holds now. A live run still
    // answers a cursor there, to resume from when it records more.
    last.entries.length >= TRANSCRIPT_ENTRY_DEFAULT;
    pages += 1
  ) {
    const next = await source.runs.transcript(ctx, runId, zoom, {
      kinds,
      after: last.cursor,
    });
    if (!next.ok) break;
    entries.push(...next.value.entries);
    last = next.value;
  }
  return {
    ok: true,
    value: {
      ...last,
      entries,
      complete: first.value.complete && last.complete,
    },
  };
}
