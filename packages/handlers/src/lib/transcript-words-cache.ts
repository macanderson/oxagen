// What a kept body says, remembered per process as a digest (ADR-182).
//
// `get_run_transcript` settles which prompts and replies have nothing to show,
// and which reply repeats words the reader was just shown, over the whole run
// on every read at `steps` (`markWords`). Each body it reads for those words
// costs a blob GET and a KMS decrypt, and the Run page reads the transcript a
// page at a time and again on every signal a live run sends. Without this
// cache, every one of those reads read every body again.
//
// The cache keeps only what `markWords` compares: whether a body shows words,
// and the digest of those words (`wordsDigest`). It keeps no text. So no read
// is ever answered with a body's text from here: a page's halves and a
// search's are read from the evidence store each time, and once erasure
// crypto-shreds a body, no read shows what it said. An entry is a few hundred
// bytes whatever the body's size, and only the words read writes to it, so a
// page of large tool bodies cannot push out the words.
//
// A body never changes: its reference names the sha256 of its bytes, and the
// read checks the bytes against the digest the frame recorded. So the digest
// of its words can be kept for as long as the process wants to keep it. The
// key holds the tenant as well as the reference and the digest, because the
// store keys a body under its organization and workspace, and one tenant's
// read must never be answered from another tenant's body.
//
// A body that cannot be read for a while is remembered as unreadable, but
// only for `failureTtlMs`: the store has no such object, its bytes no longer
// hash to the digest, or its key no longer opens it, as after erasure. An
// erased run's bodies are then not read again on every read, and a body that
// lands late is read once the entry expires. Unreadable is not "shows no
// words": the reader leaves the entry as the fold said, because only a body
// read whole can say it has nothing to show.
//
// Eviction is least recently used, bounded by entries: a `Map` keeps
// insertion order, and a hit is moved to the end.
//
// Two reads of one run often arrive together: the Run page reads `steps` and
// `everything` at once. When neither finds a body here, both would open it.
// So a read of a body is shared while it is in flight (`share`): a second
// read of the same body waits on the first instead of opening it again. The
// transcript's read keeps what the body says with `set` before its shared
// promise settles, so a read that asks after it settles finds the digest
// here. The shared promise is dropped when it settles.
import type { RunFrame, TranscriptWords } from "@oxagen/run-ledger";

/**
 * What a kept body shows a reader, as far as `markWords` compares it. A body
 * that is not a recorded model stream shows its text, whole (`words`); a
 * stream shows the last text block that has words (`last`). Each is the
 * `wordsDigest` of those words, or null when there are none.
 */
export type BodyWords =
  | { stream: false; words: TranscriptWords }
  | { stream: true; last: TranscriptWords };

export interface WordsCacheLimits {
  /** The most bodies kept. */
  maxEntries: number;
  /** How long a body that cannot be read is remembered as unreadable. */
  failureTtlMs: number;
}

/**
 * 16,384 bodies. An entry holds its key and one digest, a few hundred bytes,
 * so the cache stays under 10 MB. A long run's whole-run read asks for at
 * most 2,000 halves on each chain (`TRANSCRIPT_WORDS_HALF_MAX`). A subagent
 * chain adds a handful, so about eight such runs fit at once. A failed read
 * is remembered for a minute.
 */
export const WORDS_CACHE_LIMITS: WordsCacheLimits = {
  maxEntries: 16_384,
  failureTtlMs: 60_000,
};

interface Scope {
  orgId: string;
  workspaceId: string;
}

/** What the cache answers for a body it remembers as unreadable. */
export const UNREADABLE = "unreadable";

export interface WordsCache {
  /**
   * What is kept for the frame's body: what it says, `UNREADABLE` while a
   * failed read is remembered, or undefined when nothing is.
   */
  get(scope: Scope, frame: RunFrame): BodyWords | typeof UNREADABLE | undefined;
  /** Keep what the frame's body says. A frame with no kept body is ignored. */
  set(scope: Scope, frame: RunFrame, words: BodyWords): void;
  /**
   * Remember, for `failureTtlMs`, that the frame's body cannot be read and
   * will not be on a retry: the store has no such object, its bytes no
   * longer hash, or its key no longer opens it.
   */
  fail(scope: Scope, frame: RunFrame): void;
  /** Bodies kept, a failure included until it expires. */
  size(): number;
  /**
   * `read`, run at most once at a time for the frame's body. While one read
   * of the body is in flight, a second caller is handed its promise and
   * opens nothing. Once it settles, the next caller runs `read` again. A
   * frame with no kept body is read every time.
   */
  share<T>(scope: Scope, frame: RunFrame, read: () => Promise<T>): Promise<T>;
}

function keyOf(scope: Scope, frame: RunFrame): string | null {
  const { bodyRef, bodyDigest } = frame.body;
  if (bodyRef === null || bodyDigest === null) return null;
  return `${scope.orgId}\n${scope.workspaceId}\n${bodyRef}\n${bodyDigest}`;
}

export function createWordsCache(
  limits: WordsCacheLimits = WORDS_CACHE_LIMITS,
  now: () => number = Date.now,
): WordsCache {
  type Held = BodyWords | typeof UNREADABLE;
  const kept = new Map<string, { words: Held; until: number | null }>();

  const keep = (key: string, words: Held, until: number | null) => {
    kept.delete(key);
    if (limits.maxEntries < 1) return;
    while (kept.size >= limits.maxEntries) {
      const oldest = kept.keys().next();
      if (oldest.done === true) break;
      kept.delete(oldest.value);
    }
    kept.set(key, { words, until });
  };

  // Keyed like `kept`. Every caller that shares a read of one body reads it
  // into the same type, so a promise held here is the type its caller names.
  const inFlight = new Map<string, Promise<unknown>>();

  return {
    get(scope, frame) {
      const key = keyOf(scope, frame);
      if (key === null) return undefined;
      const held = kept.get(key);
      if (held === undefined) return undefined;
      kept.delete(key);
      if (held.until !== null && now() >= held.until) return undefined;
      kept.set(key, held);
      return held.words;
    },
    set(scope, frame, words) {
      const key = keyOf(scope, frame);
      if (key !== null) keep(key, words, null);
    },
    fail(scope, frame) {
      const key = keyOf(scope, frame);
      if (key !== null) keep(key, UNREADABLE, now() + limits.failureTtlMs);
    },
    size() {
      return kept.size;
    },
    share<T>(scope: Scope, frame: RunFrame, read: () => Promise<T>) {
      const key = keyOf(scope, frame);
      if (key === null) return read();
      const pending = inFlight.get(key);
      if (pending !== undefined) return pending as Promise<T>;
      const started = read().finally(() => inFlight.delete(key));
      inFlight.set(key, started);
      return started;
    },
  };
}
