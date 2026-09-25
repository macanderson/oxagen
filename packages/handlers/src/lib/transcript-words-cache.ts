// The words a kept body shows a reader, remembered per process (ADR-182).
//
// `get_run_transcript` settles which prompts and replies have nothing to show,
// and which reply repeats words the reader was just shown, over the whole run
// on every read at `steps` (`markWords`). Each body it reads for those words
// costs a blob GET and a KMS decrypt, and the Run page reads the transcript a
// page at a time and again on every signal a live run sends. Without this
// cache, every one of those reads read every body again.
//
// A body never changes: its reference names the sha256 of its bytes, and the
// read checks the bytes against the digest the frame recorded. So what a body
// says can be kept for as long as the process wants to keep it. The key holds
// the tenant as well as the reference and the digest, because the store keys a
// body under its organization and workspace, and one tenant's read must never
// be answered from another tenant's body.
//
// The cache is bounded twice: by entries, and by the characters it holds. A
// body whose words alone pass `maxValueChars` is not kept, so one very long
// prompt cannot push out the rest; it is read again on each read. Eviction is
// least recently used: a `Map` keeps insertion order, and a hit is moved to the
// end.
import type { RunFrame } from "@oxagen/run-ledger";

/**
 * What a kept body shows a reader, as far as its words go. A body that is not
 * a recorded model stream shows its text, whole; a stream shows the last text
 * block that has words (`last`), or none.
 */
export type BodyWords =
  | { stream: false; text: string }
  | { stream: true; last: string | null };

export interface WordsCacheLimits {
  /** The most bodies kept. */
  maxEntries: number;
  /** The most characters kept, over every body's words and key. */
  maxChars: number;
  /** A body whose words pass this many characters is not kept. */
  maxValueChars: number;
}

/**
 * 8,192 bodies and 8 Mi characters (about 16 MiB of UTF-16), with no one body
 * over 1 Mi characters. A long run's whole-run read asks for at most 2,000
 * halves (`TRANSCRIPT_WORDS_HALF_MAX`), so four such runs fit at once.
 */
export const WORDS_CACHE_LIMITS: WordsCacheLimits = {
  maxEntries: 8_192,
  maxChars: 8 * 1_048_576,
  maxValueChars: 1_048_576,
};

interface Scope {
  orgId: string;
  workspaceId: string;
}

export interface WordsCache {
  /** The words kept for the frame's body, or undefined when none are. */
  get(scope: Scope, frame: RunFrame): BodyWords | undefined;
  /** Keep what the frame's body says. A frame with no kept body is ignored. */
  set(scope: Scope, frame: RunFrame, words: BodyWords): void;
  /** Bodies kept, and the characters they hold. */
  size(): { entries: number; chars: number };
}

function keyOf(scope: Scope, frame: RunFrame): string | null {
  const { bodyRef, bodyDigest } = frame.body;
  if (bodyRef === null || bodyDigest === null) return null;
  return `${scope.orgId}\n${scope.workspaceId}\n${bodyRef}\n${bodyDigest}`;
}

function charsOf(words: BodyWords): number {
  return words.stream ? (words.last?.length ?? 0) : words.text.length;
}

export function createWordsCache(
  limits: WordsCacheLimits = WORDS_CACHE_LIMITS,
): WordsCache {
  const kept = new Map<string, { words: BodyWords; chars: number }>();
  let chars = 0;

  const drop = (key: string) => {
    const held = kept.get(key);
    if (held === undefined) return;
    kept.delete(key);
    chars -= held.chars;
  };

  return {
    get(scope, frame) {
      const key = keyOf(scope, frame);
      if (key === null) return undefined;
      const held = kept.get(key);
      if (held === undefined) return undefined;
      kept.delete(key);
      kept.set(key, held);
      return held.words;
    },
    set(scope, frame, words) {
      const key = keyOf(scope, frame);
      if (key === null) return;
      const value = charsOf(words);
      drop(key);
      if (value > limits.maxValueChars) return;
      const size = value + key.length;
      if (size > limits.maxChars || limits.maxEntries < 1) return;
      while (kept.size >= limits.maxEntries || chars + size > limits.maxChars) {
        const oldest = kept.keys().next();
        if (oldest.done === true) break;
        drop(oldest.value);
      }
      kept.set(key, { words, chars: size });
      chars += size;
    },
    size() {
      return { entries: kept.size, chars };
    },
  };
}
