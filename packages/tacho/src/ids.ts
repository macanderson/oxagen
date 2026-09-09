import { createHash, randomBytes } from "node:crypto";

/**
 * Deterministic identity, derived at the client so a re-send after a lost
 * ack lands on the same row. Namespaces are frozen: changing one changes
 * every derived id, which is a wire-format change.
 */
export const NS_TACHO_SESSION = "0f2d7f4e-6c1b-4f0a-9c3e-2a5d9b7e1c01";
export const NS_TACHO_EFFECT = "0f2d7f4e-6c1b-4f0a-9c3e-2a5d9b7e1c02";

function uuidBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new TypeError(`not a uuid: ${uuid}`);
  }
  return Buffer.from(hex, "hex");
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** RFC 4122 section 4.3 name-based UUID (version 5, SHA-1). */
export function uuidv5(namespace: string, name: string): string {
  const hash = createHash("sha1")
    .update(uuidBytes(namespace))
    .update(Buffer.from(name, "utf8"))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return formatUuid(bytes);
}

/**
 * `session_uuid = uuidv5(NS_TACHO_SESSION, "<scope>/<harness session id>")`
 * where scope is the host enrollment id for Claude Code hosts or the agent
 * key for SDK agents.
 */
export function sessionUuid(scope: string, harnessSessionId: string): string {
  return uuidv5(NS_TACHO_SESSION, `${scope}/${harnessSessionId}`);
}

/** `evt_` + sha256(session_uuid, seq): the idempotency key of one event. */
export function eventIdIdem(sessionUuidValue: string, seq: number): string {
  if (!Number.isInteger(seq) || seq < 0) {
    throw new TypeError(`seq must be a non-negative integer, got ${seq}`);
  }
  const hash = createHash("sha256")
    .update(sessionUuidValue)
    .update(" ")
    .update(String(seq))
    .digest("hex");
  return `evt_${hash}`;
}

/**
 * An intended-once effect id: the same (session, tool use, target) performed
 * twice is the crash-replay bug by construction.
 */
export function effectId(
  sessionUuidValue: string,
  toolUseId: string,
  target: string,
): string {
  return `eff_${createHash("sha256")
    .update(sessionUuidValue)
    .update(" ")
    .update(toolUseId)
    .update(" ")
    .update(target)
    .digest("hex")}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 10 chars of time (ms), 16 chars of randomness, Crockford base32. */
export function ulid(now: number = Date.now()): string {
  let time = now;
  let timePart = "";
  for (let index = 0; index < 10; index += 1) {
    timePart = CROCKFORD[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  const random = randomBytes(16);
  let randomPart = "";
  for (let index = 0; index < 16; index += 1) {
    randomPart += CROCKFORD[(random[index] ?? 0) % 32];
  }
  return timePart + randomPart;
}

export function newEventId(now?: number): string {
  return `evt_${ulid(now)}`;
}
