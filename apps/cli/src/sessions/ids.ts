/**
 * Session id minting for the fleet (ADR-023).
 *
 * Ids are short, human-typeable, and time-sortable: `s-<base36 ms>-<4 rand>`.
 * The base36 timestamp keeps `ls` and rosters naturally chronological; the
 * random tail keeps two dispatches in the same millisecond distinct. Ids are
 * safe as directory names on every filesystem we target.
 */
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randBase36(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[(bytes[i] as number) % 36];
  return out;
}

/** Mint a new session id, e.g. `s-mcqk3x9a-7f2q`. */
export function newSessionId(now: number = Date.now()): string {
  return `s-${now.toString(36)}-${randBase36(4)}`;
}

/** True when `value` looks like a session id this CLI minted. */
export function isSessionId(value: string): boolean {
  return /^s-[0-9a-z]+-[0-9a-z]{4}$/.test(value);
}

/**
 * The short display form of a session id — the random tail, which is the only
 * segment a human needs to disambiguate sessions within one fleet (the
 * timestamp segment is shared noise on rosters). `s-mcqk3x9a-7f2q` → `7f2q`.
 */
export function shortSid(sid: string): string {
  const tail = sid.split("-")[2];
  return tail && tail.length > 0 ? tail : sid;
}

/**
 * Resolve a user-typed session reference (full id, short tail, or unique
 * prefix of either) against the known ids. Returns the single match, or null
 * when the reference is ambiguous or unknown.
 */
export function resolveSidRef(
  ref: string,
  known: readonly string[],
): string | null {
  const exact = known.find((k) => k === ref);
  if (exact) return exact;
  const matches = known.filter(
    (k) =>
      shortSid(k) === ref || k.startsWith(ref) || shortSid(k).startsWith(ref),
  );
  return matches.length === 1 ? (matches[0] as string) : null;
}
