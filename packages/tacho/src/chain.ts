/**
 * The per-session hash chain (design/trace-model.md section 2).
 *
 * `hash = sha256(JCS(event without hash))`, `prev_hash` links seq n-1 to n,
 * and the genesis event (seq 0) carries `prev_hash = sha256("")`. Every
 * member of the event, including redactions, is under the hash, so a
 * redaction is visible and the chain stays valid.
 */
import {
  digestBytes,
  digestJcs,
  hasToJsonMember,
  type JsonValue,
  legacyJcs,
  type Sha256Digest,
} from "./digest";
import { eventIdIdem } from "./ids";
import {
  type TachoEvent,
  type UnsealedTachoEvent,
  parseTachoEvent,
} from "./envelope";

export const GENESIS_PREV_HASH: Sha256Digest = digestBytes("");

/** JSON.parse(JSON.stringify(x)) as a typed JsonValue: drops undefined members. */
function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** The digest the chain rule assigns to an event, ignoring any `hash` it carries. */
export function hashEvent(event: Record<string, unknown>): Sha256Digest {
  const { hash: _ignored, ...rest } = event;
  return digestJcs(toJson(rest));
}

/**
 * The rule an event's hash was taken under, or undefined when it hashes to
 * `hash` under neither.
 *
 * `jcs` is the rule `hashEvent` seals with. An event a build before it
 * sealed, whose content holds a member named `toJSON` (an attribute a host
 * named that, most likely), hashed to the text `canonicalize@1.0.8` wrote
 * instead, `legacyJcs`. That form is accepted too, so an older host's events
 * still verify at ingest, in an export, and when a row is rebuilt. It holds
 * only in the key order the event was sealed in, and for no event without
 * that member, since the two texts are the same for every other value.
 */
export function eventHashRule(
  event: Record<string, unknown>,
  hash: unknown,
): "jcs" | "legacy" | undefined {
  const { hash: _ignored, ...rest } = event;
  const value = toJson(rest);
  if (digestJcs(value) === hash) return "jcs";
  if (hasToJsonMember(value) && digestBytes(legacyJcs(value)) === hash)
    return "legacy";
  return undefined;
}

/** Whether an event hashes to `hash` under either rule (`eventHashRule`). */
export function eventHashHolds(
  event: Record<string, unknown>,
  hash: unknown,
): boolean {
  return eventHashRule(event, hash) !== undefined;
}

export interface ChainCursor {
  seq: number;
  prevHash: Sha256Digest;
}

export const GENESIS_CURSOR: ChainCursor = {
  seq: 0,
  prevHash: GENESIS_PREV_HASH,
};

/** Satisfies the schema while the real hash is computed over the parsed event. */
const PLACEHOLDER_HASH: Sha256Digest = `sha256:${"0".repeat(64)}`;

/**
 * Assign the next dense `seq`, the idempotency id, `prev_hash`, and `hash`,
 * and validate the result against the wire schema. Returns the sealed event
 * and the cursor for the next one. Pure: the caller owns persistence.
 */
export function sealEvent(
  unsealed: UnsealedTachoEvent,
  cursor: ChainCursor,
): { event: TachoEvent; next: ChainCursor } {
  const seq = cursor.seq;
  // Parse first so schema defaults (the attrs map, the redactions list) are
  // part of what gets hashed: the hash must cover the event as stored, not
  // as the producer happened to spell it.
  const normalized = parseTachoEvent({
    ...unsealed,
    seq,
    event_id_idem: eventIdIdem(unsealed.session_uuid, seq),
    prev_hash: cursor.prevHash,
    hash: PLACEHOLDER_HASH,
  });
  const hash = hashEvent(normalized as unknown as Record<string, unknown>);
  const event = { ...normalized, hash } as TachoEvent;
  return { event, next: { seq: seq + 1, prevHash: hash } };
}

export interface ChainVerification {
  ok: boolean;
  /** Human-readable findings naming the exact `seq` values involved. */
  violations: string[];
  eventCount: number;
  finalHash: Sha256Digest | null;
}

/** Recompute every hash and link over an ordered slice of one session. */
export function verifyChain(
  events: readonly TachoEvent[],
  options: { expectGenesis?: boolean } = {},
): ChainVerification {
  const violations: string[] = [];
  let prev: Sha256Digest | null = null;
  let expectedSeq: number | null = null;
  const session = events[0]?.session_uuid;

  events.forEach((event, index) => {
    if (event.session_uuid !== session) {
      violations.push(
        `seq ${event.seq} belongs to session ${event.session_uuid}, not ${session}`,
      );
    }
    if (index === 0) {
      if (options.expectGenesis !== false && event.seq !== 0) {
        violations.push(`chain opens at seq ${event.seq}, not 0`);
      }
      if (event.seq === 0 && event.prev_hash !== GENESIS_PREV_HASH) {
        violations.push(
          `genesis prev_hash is ${event.prev_hash}, not sha256("")`,
        );
      }
    } else {
      if (expectedSeq !== null && event.seq !== expectedSeq) {
        violations.push(
          `seq ${event.seq} follows seq ${expectedSeq - 1}: the sequence must be dense`,
        );
      }
      if (prev !== null && event.prev_hash !== prev) {
        violations.push(
          `seq ${event.seq} prev_hash does not match the hash of seq ${event.seq - 1}`,
        );
      }
    }
    if (
      !eventHashHolds(event as unknown as Record<string, unknown>, event.hash)
    ) {
      violations.push(`seq ${event.seq} hash does not match its content`);
    }
    if (event.event_id_idem !== eventIdIdem(event.session_uuid, event.seq)) {
      violations.push(
        `seq ${event.seq} event_id_idem is not derived from (session_uuid, seq)`,
      );
    }
    prev = event.hash as Sha256Digest;
    expectedSeq = event.seq + 1;
  });

  return {
    ok: violations.length === 0 && events.length > 0,
    violations: events.length === 0 ? ["no events"] : violations,
    eventCount: events.length,
    finalHash: prev,
  };
}
