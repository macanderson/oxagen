/**
 * transcript-cap.ts — bound the in-memory REPL transcript on long sessions.
 *
 * A long-running session appends to the transcript indefinitely (memory grows
 * without limit, and the full-screen render re-measures every committed row).
 * `capTranscript` keeps only the most recent `max` entries.
 *
 * Two invariants that make this safe to call every commit:
 *   - Identity-preserving: when the list is already within `max`, the SAME
 *     array reference is returned, and retained entries are always the original
 *     objects (a plain `slice`). That keeps `React.memo(MessageView)` effective —
 *     untouched rows never look "changed".
 *   - Applied ONLY where trimming is sound. In inline mode the REPL commits
 *     finished rows through Ink's `<Static>`, which is strictly append-only:
 *     its internal cursor skips any row that shifts below a previously-written
 *     index, so trimming the fed array would silently drop the newest message.
 *     The caller therefore trims only in full-screen mode (alternate screen
 *     buffer, no `<Static>` — every row is re-sliced from React state each
 *     frame, so dropping the oldest is both safe and what bounds the O(N)
 *     row-height pass). Model history is bounded separately by the engine's
 *     token-budget compaction, so it is not this helper's concern.
 */

/** Default ceiling on retained transcript rows — generous; normal sessions never hit it. */
export const MAX_TRANSCRIPT_MESSAGES = 500;

/**
 * Return at most `max` entries, keeping the most recent (drops from the front).
 * Returns the input array unchanged when it is already within `max`.
 */
export function capTranscript<T>(
  list: T[],
  max: number = MAX_TRANSCRIPT_MESSAGES,
): T[] {
  if (max <= 0) return [];
  if (list.length <= max) return list;
  return list.slice(list.length - max);
}
