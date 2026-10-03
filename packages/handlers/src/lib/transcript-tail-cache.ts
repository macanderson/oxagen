// Where a live reader's next read of the transcript can start, kept per
// process between two reads of one run (#4340).
//
// A read from a cursor reads a window of the run that starts on a turn's
// first frame (`TranscriptWindowFrom`). A step never crosses a turn, so no
// frame that lands later can join a step that opened before the window. But a
// coding agent's run is often one long turn, so following it read the whole
// turn, which is most of the run, on every update.
//
// So a read of a live run at `steps` also picks a later frame inside the
// turn, the tail start, and keeps here what a read from there needs to fold
// the way the turn's window folds: the run's turn, cost and proxy state at
// that frame, whether the run counts its turns by their opening frames, and
// the call keys the window recorded before it. Inside a turn the fold joins
// frames by call key however far apart they are, so the keys are what make
// the shorter read exact: the next read from the cursor checks that no frame
// it read names one of them, and reads the turn's window when one does.
//
// An entry is keyed by the cursor the read wrote, so only the next read from
// that cursor finds it, and that read takes it. A cursor with no entry here
// (another process served the read before, or the entry was evicted) reads
// the turn's window, as every read did before this cache.
//
// The cache keeps no frames, bodies or text, only call keys. Eviction is
// least recently written, bounded by entries and by the keys all entries
// hold together (`TAIL_CACHE_LIMITS`).

/** What a read from a tail start carries in from the frames before it. */
export interface TailStart {
  /** The seq of the tail start, a frame on the run's own chain. */
  seq: string;
  /** The run's turn at that frame; null before the run's first turn. */
  turn: number | null;
  /** The run's cumulative cost before that frame, in micros; null before any cost. */
  cost: number | null;
  /** The proxy observed a model call on the run's own chain before that frame. */
  observed: boolean;
  /** The run counts its turns by their opening frames (`turnOrdinals`). */
  byOpeners: boolean;
  /**
   * The call keys of every frame the turn's window holds before the tail
   * start, each as `<session uuid or empty>\u0000<key>` (`tailCallKeys`).
   */
  keys: ReadonlySet<string>;
}

export interface TailCacheLimits {
  /** The most tail starts kept: about one per reader following a live run. */
  maxEntries: number;
  /** The most call keys all kept tail starts hold together. */
  maxKeys: number;
}

/**
 * 512 tail starts and 32,768 call keys. A key is a tool call's id or a model
 * call's request id with its chain, about 100 bytes held, so the keys take
 * about 3 MB and the cache stays under 4 MB. One follower holds one entry at
 * a time, because its next read takes the one before. A turn with more keys
 * than the whole bound keeps no tail start, and its readers read the turn's
 * window.
 */
export const TAIL_CACHE_LIMITS: TailCacheLimits = {
  maxEntries: 512,
  maxKeys: 32_768,
};

export interface TailCache {
  /** Keep `start` for the next read from `key`. A start past `maxKeys` is not kept. */
  put(key: string, start: TailStart): void;
  /** The start kept for `key`, removed as it is returned; null when none is kept. */
  take(key: string): TailStart | null;
  /** The entries and call keys held. */
  size(): { entries: number; keys: number };
}

export function createTailCache(
  limits: TailCacheLimits = TAIL_CACHE_LIMITS,
): TailCache {
  const kept = new Map<string, TailStart>();
  let keys = 0;

  const drop = (key: string): TailStart | null => {
    const start = kept.get(key);
    if (start === undefined) return null;
    kept.delete(key);
    keys -= start.keys.size;
    return start;
  };

  return {
    put(key, start) {
      drop(key);
      if (limits.maxEntries < 1 || start.keys.size > limits.maxKeys) return;
      kept.set(key, start);
      keys += start.keys.size;
      // A Map iterates in insertion order, so the first key is the oldest.
      for (const oldest of kept.keys()) {
        if (kept.size <= limits.maxEntries && keys <= limits.maxKeys) break;
        drop(oldest);
      }
    },
    take(key) {
      return drop(key);
    },
    size() {
      return { entries: kept.size, keys };
    },
  };
}
