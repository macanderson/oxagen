/**
 * Transcript token estimation.
 *
 * A heuristic, not a tokenizer: it exists to decide when a transcript is big
 * enough to act on, and the pipeline compacts well below any true window, so
 * being approximately right is the requirement. Lives on its own because the
 * one thing that needs it — the pipeline's pre-flight cost projection — is not
 * the thing it was written for, and the step loop it was written for is gone.
 */
import type { ModelMessage } from "ai";

/**
 * Flat token estimates for binary multimodal content parts. A base64 image or
 * video payload is a giant string whose *serialized length* is a meaningless
 * token proxy — one ~1 MB screenshot is ~1.3 M base64 chars ≈ 330 k "tokens" by
 * length/4, which would stampede compaction every single step. Worse, the
 * transcript compactor ({@link truncateContent}) cannot shrink an `image`/`file`
 * part, so that phantom overcount would never abate: the loop would truncate all
 * the *real* text around a static image forever. Instead we price each media
 * part at a flat per-asset constant near what vision models actually bill an
 * image/short clip at. ADR-021 §2 (context/KV-cache discipline). Exported for tests.
 */
export const IMAGE_PART_TOKENS = 1600;
export const FILE_PART_TOKENS = 2000;

/**
 * Per-message memo of {@link contentTokens}, keyed by the message object's
 * identity. The step loop calls {@link estimateMessageTokens} over the WHOLE
 * transcript every step (an O(n²) sweep over the turn), yet each message's
 * content is immutable once appended — compaction produces NEW message objects
 * (`{ ...msg, content }`) for anything it changes, so a cache keyed by object
 * identity is self-invalidating: a rewritten message misses (new key) and a
 * carried-over message hits. WeakMap so retired transcripts are GC'd, never a
 * leak. The estimate is a pure function of `content`, so a memo is exact.
 */
const messageTokenCache = new WeakMap<object, number>();

/**
 * Rough token estimate: ~4 chars per token over serialized content, except
 * binary media parts, which are counted at a flat per-asset constant (see
 * {@link IMAGE_PART_TOKENS}/{@link FILE_PART_TOKENS}). Deliberately a heuristic —
 * no tokenizer dependency, and it only needs to be good enough to decide WHEN to
 * compact (we compact well below the true window). Per-message results are memoed
 * by object identity (see {@link messageTokenCache}) so re-measuring an unchanged
 * transcript every step is O(changed), not O(total). Exported for tests.
 */
export function estimateMessageTokens(messages: ModelMessage[]): number {
  let tokens = 0;
  for (const m of messages) {
    // A message is always an object here; guard defensively so a malformed
    // entry can't wedge the cache lookup, and fall back to a direct measure.
    if (m && typeof m === "object") {
      const cached = messageTokenCache.get(m);
      if (cached !== undefined) {
        tokens += cached;
        continue;
      }
      const measured = contentTokens(m.content);
      messageTokenCache.set(m, measured);
      tokens += measured;
    } else {
      tokens += contentTokens((m as ModelMessage).content);
    }
  }
  return tokens;
}

/** Token estimate for a single message's content, media-part-aware. */
function contentTokens(content: unknown): number {
  if (content == null) return 0;
  if (typeof content === "string") return Math.ceil(content.length / 4);
  if (Array.isArray(content)) {
    let tokens = 0;
    for (const part of content) {
      if (part && typeof part === "object") {
        const type = (part as Record<string, unknown>)["type"];
        // Image/video (AI-SDK `file`) parts carry a base64 payload — count them
        // flat, never by serialized length.
        if (type === "image") {
          tokens += IMAGE_PART_TOKENS;
          continue;
        }
        if (type === "file") {
          tokens += FILE_PART_TOKENS;
          continue;
        }
      }
      // Text / tool-call / tool-result and any other part: size by length/4.
      tokens += Math.ceil(serializedLength(part) / 4);
    }
    return tokens;
  }
  return Math.ceil(serializedLength(content) / 4);
}

/** Serialized character length of a value, falling back gracefully. */
function serializedLength(v: unknown): number {
  if (typeof v === "string") return v.length;
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return String(v).length;
  }
}
