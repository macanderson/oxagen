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

type Prior = {
  /** Digest of the previous call's full decoded request text. */
  requestDigest: Sha256Digest;
  conversation: { field: string; items: Sha256Digest[] } | undefined;
  fixed: Map<string, Sha256Digest>;
};

export type PriorMarker = {
  /** The call the cut prefix is recorded on: its `request_full_digest`. */
  unchanged_from: Sha256Digest;
  /** How many leading items of the conversation array that call already holds. */
  messages: number;
  /** The fixed fields that call already holds verbatim. */
  fields: string[];
};

/** What a fold did, for the event's own facts. */
export type PrefixFold = {
  /** The request to store: the original text when nothing folded. */
  text: string;
  /** Digest of the full decoded request, before any fold. */
  fullDigest: Sha256Digest;
  fullBytes: number;
  storedBytes: number;
  /** Present when a prefix was cut. */
  prior: PriorMarker | undefined;
};

export class RequestPrefixMemory {
  private readonly priors = new Map<string, Prior>();

  /** Forget a session that ended, so the memory does not grow with the day. */
  forget(sessionKey: string): void {
    this.priors.delete(sessionKey);
  }

  /**
   * Fold `requestText` against the session's previous call and remember
   * this one. The returned text is what to store.
   */
  fold(sessionKey: string, requestText: string): PrefixFold {
    const fullDigest = digestBytes(requestText);
    const fullBytes = Buffer.byteLength(requestText, "utf8");
    const unchanged: PrefixFold = {
      text: requestText,
      fullDigest,
      fullBytes,
      storedBytes: fullBytes,
      prior: undefined,
    };
    const parsed = parseObject(requestText);
    if (parsed === undefined) {
      this.priors.delete(sessionKey);
      return unchanged;
    }
    const current = describe(parsed, fullDigest);
    const previous = this.priors.get(sessionKey);
    this.remember(sessionKey, current);
    if (previous === undefined) return unchanged;

    const stored: Record<string, JsonValue | undefined> = { ...parsed };
    let messages = 0;
    if (
      current.conversation !== undefined &&
      previous.conversation !== undefined &&
      current.conversation.field === previous.conversation.field
    ) {
      messages = commonPrefix(
        previous.conversation.items,
        current.conversation.items,
      );
      if (messages > 0) {
        const items = parsed[current.conversation.field];
        if (Array.isArray(items)) {
          stored[current.conversation.field] = items.slice(messages);
        }
      }
    }
    const fields: string[] = [];
    for (const [field, digest] of current.fixed) {
      if (previous.fixed.get(field) === digest) {
        fields.push(field);
        delete stored[field];
      }
    }
    if (messages === 0 && fields.length === 0) return unchanged;
    const prior: PriorMarker = {
      unchanged_from: previous.requestDigest,
      messages,
      fields,
    };
    stored[PRIOR_MEMBER] = prior;
    const text = JSON.stringify(stored);
    const storedBytes = Buffer.byteLength(text, "utf8");
    // A fold that saves nothing is noise: the pointer outweighs a one-line
    // prefix, and a reader would follow it for less than it cost.
    if (storedBytes >= fullBytes) return unchanged;
    return { text, fullDigest, fullBytes, storedBytes, prior };
  }

  private remember(sessionKey: string, prior: Prior): void {
    // Re-insert so the map's order is last-use order, then trim the oldest.
    this.priors.delete(sessionKey);
    this.priors.set(sessionKey, prior);
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
): Prior {
  let conversation: Prior["conversation"];
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
