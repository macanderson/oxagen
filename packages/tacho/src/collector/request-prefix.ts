/**
 * A model request stored once per turn of the conversation, not once per call.
 *
 * A harness sends the whole conversation on every model call: the system
 * prompt, the tool definitions, and every message so far, plus the one thing
 * that is new. Recorded as sent, a session's `llm_call` bodies repeat the
 * first prompt on every call and grow with the square of the session's
 * length. One twelve-hour session on 2026-09-21 held 16,436 request bodies
 * and 7.4 GB, and 99 percent of those bytes were messages already recorded
 * on the call before.
 *
 * So the proxy remembers, per session, a digest of each message and of the
 * fixed fields the previous call carried, and stores the next request with
 * the unchanged prefix cut out. What ships is still a request object: its
 * `messages` are the messages that are new since the previous call, and a
 * `$oxagen_prior` member says what was cut and which call carries it, by the
 * digest of that call's full decoded request. A reader rebuilds the whole
 * request by following those digests back through the session; a reader
 * that only wants what changed reads the body as it is.
 *
 * The fold is exact or not at all. A message is unchanged only when its
 * canonical JSON digests the same, and the fold stops at the first message
 * that differs, so an edited turn, a compaction, or a retry that rewrote
 * history stores everything from that point on in full. A request whose
 * shape this module does not recognise is stored as it came.
 *
 * Nothing here decides retention: it runs only on a request the workspace has
 * already chosen to keep, and the digest the chain carries names the bytes
 * that ship, as before.
 *
 * Folding and remembering are two steps. `fold` cuts a request against the
 * session's prior and changes nothing. `remember` makes a request the
 * session's prior, and the proxy calls it only once the call's frame, with
 * the body in it, is on the WAL. So a stored request names only a body that
 * landed. Two calls that overlap never point at each other: the second folds
 * against the last call that landed before it, or is stored whole. If the
 * first call's frame then fails to reach the WAL, nothing points at the body
 * it lost (#4348).
 *
 * `remember` can keep a payload beside the request. The proxy keeps the
 * request's system context there (`claude-code/system-context.ts`), so the
 * context of a call lives as long as a later fold can name that call, and is
 * evicted with its session.
 */
import {
  type JsonValue,
  digestBytes,
  digestJcs,
  type Sha256Digest,
} from "../digest";

/** The conversation arrays a request may carry, by API shape. */
const CONVERSATION_FIELDS = ["messages", "input"] as const;
/** Fields that repeat verbatim from call to call and are large. */
const FIXED_FIELDS = ["system", "tools", "instructions"] as const;

/** How many sessions the memory holds before the oldest is forgotten. */
const MEMORY_SESSIONS = 512;

/** The member that names what the stored request leaves out. */
export const PRIOR_MEMBER = "$oxagen_prior";

/**
 * What the memory keeps of one request: its digest, and the digests a later
 * fold compares against.
 */
export type RequestShape = {
  /** Digest of the call's full decoded request text. */
  requestDigest: Sha256Digest;
  conversation: { field: string; items: Sha256Digest[] } | undefined;
  fixed: Map<string, Sha256Digest>;
};

/** A session's prior: the request's shape and what the caller kept beside it. */
type Remembered<T> = { shape: RequestShape; payload: T | undefined };

export type PriorMarker = {
  /** The call the cut prefix is recorded on: its `request_full_digest`. */
  unchanged_from: Sha256Digest;
  /** How many leading items of the conversation array that call already holds. */
  messages: number;
  /** The fixed fields that call already holds verbatim. */
  fields: string[];
};

/** What a fold did, for the event's own facts. */
export type PrefixFold<T = unknown> = {
  /** The request to store: the original text when nothing folded. */
  text: string;
  /** Digest of the full decoded request, before any fold. */
  fullDigest: Sha256Digest;
  fullBytes: number;
  storedBytes: number;
  /** Present when a prefix was cut. */
  prior: PriorMarker | undefined;
  /**
   * What `remember` records of this request. Undefined when the text is not
   * a JSON object, which nothing can fold against.
   */
  shape: RequestShape | undefined;
  /**
   * The payload remembered with the call `prior` names, as it stood when
   * the fold ran. Undefined when nothing was cut, or when that call was
   * remembered without one.
   */
  priorPayload: T | undefined;
};

/**
 * Each session's prior, and what the caller kept beside it. `T` is that
 * payload's type. A memory that keeps no payload leaves it `never`.
 */
export class RequestPrefixMemory<T = never> {
  private readonly priors = new Map<string, Remembered<T>>();

  /** Forget a session that ended, so the memory does not grow with the day. */
  forget(sessionKey: string): void {
    this.priors.delete(sessionKey);
  }

  /**
   * Fold `requestText` against the session's prior. The returned text is
   * what to store. The memory does not change: call `remember` once that
   * text has landed.
   */
  fold(sessionKey: string, requestText: string): PrefixFold<T> {
    const fullDigest = digestBytes(requestText);
    const fullBytes = Buffer.byteLength(requestText, "utf8");
    const parsed = parseObject(requestText);
    const shape =
      parsed === undefined ? undefined : describe(parsed, fullDigest);
    const unchanged: PrefixFold<T> = {
      text: requestText,
      fullDigest,
      fullBytes,
      storedBytes: fullBytes,
      prior: undefined,
      shape,
      priorPayload: undefined,
    };
    if (parsed === undefined || shape === undefined) return unchanged;
    const previous = this.priors.get(sessionKey);
    if (previous === undefined) return unchanged;
    const before = previous.shape;

    const stored: Record<string, JsonValue | undefined> = { ...parsed };
    let messages = 0;
    if (
      shape.conversation !== undefined &&
      before.conversation !== undefined &&
      shape.conversation.field === before.conversation.field
    ) {
      messages = commonPrefix(
        before.conversation.items,
        shape.conversation.items,
      );
      if (messages > 0) {
        const items = parsed[shape.conversation.field];
        if (Array.isArray(items)) {
          stored[shape.conversation.field] = items.slice(messages);
        }
      }
    }
    const fields: string[] = [];
    for (const [field, digest] of shape.fixed) {
      if (before.fixed.get(field) === digest) {
        fields.push(field);
        delete stored[field];
      }
    }
    if (messages === 0 && fields.length === 0) return unchanged;
    const prior: PriorMarker = {
      unchanged_from: before.requestDigest,
      messages,
      fields,
    };
    stored[PRIOR_MEMBER] = prior;
    const text = JSON.stringify(stored);
    const storedBytes = Buffer.byteLength(text, "utf8");
    // A fold that saves nothing is noise: the pointer outweighs a one-line
    // prefix, and a reader would follow it for less than it cost.
    if (storedBytes >= fullBytes) return unchanged;
    return {
      text,
      fullDigest,
      fullBytes,
      storedBytes,
      prior,
      shape,
      priorPayload: previous.payload,
    };
  }

  /**
   * Make `fold`'s request the session's prior, with `payload` beside it.
   * Call it only once the body holding `fold.text` has landed, so no later
   * call points at a body that is not there. A request that is not a JSON
   * object forgets the session instead: nothing can fold against it.
   */
  remember(sessionKey: string, fold: PrefixFold<T>, payload?: T): void {
    this.priors.delete(sessionKey);
    if (fold.shape === undefined) return;
    // Re-inserted, so the map's order is last-use order. Then the oldest
    // session is trimmed.
    this.priors.set(sessionKey, { shape: fold.shape, payload });
    while (this.priors.size > MEMORY_SESSIONS) {
      const oldest = this.priors.keys().next().value;
      if (oldest === undefined) break;
      this.priors.delete(oldest);
    }
  }
}

function parseObject(
  text: string,
): Record<string, JsonValue | undefined> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, JsonValue | undefined>;
}

function describe(
  request: Record<string, JsonValue | undefined>,
  requestDigest: Sha256Digest,
): RequestShape {
  let conversation: RequestShape["conversation"];
  for (const field of CONVERSATION_FIELDS) {
    const items = request[field];
    if (Array.isArray(items)) {
      conversation = { field, items: items.map((item) => digestJcs(item)) };
      break;
    }
  }
  const fixed = new Map<string, Sha256Digest>();
  for (const field of FIXED_FIELDS) {
    const value = request[field];
    if (value !== undefined) fixed.set(field, digestJcs(value));
  }
  return { requestDigest, conversation, fixed };
}

function commonPrefix(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}
