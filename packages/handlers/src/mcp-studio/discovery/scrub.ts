// scrub.ts: keep a credential out of every error, log line, snapshot row,
// and steering PR that discovery writes (lane M10, #4682).
//
// Discovery places a credential on a request and then may quote an error
// from the upstream or the transport. A server can echo a header back in its
// error body, so every text discovery stores or sends passes through the
// scrubber of the run, which knows each secret the run placed.

/**
 * A secret shorter than this is not scrubbed, so a one-letter value cannot
 * erase the text. Discovery refuses to place a shorter secret at all.
 */
export const MIN_SECRET_LENGTH = 4;

export const REDACTED = "[redacted]";

export interface Scrubber {
  /** Remember a value the run placed on a request. */
  add(secret: string): void;
  /** The text with every remembered value, and its common encodings, replaced. */
  scrub(text: string): string;
}

function encodings(secret: string): string[] {
  const out = [secret, encodeURIComponent(secret), Buffer.from(secret, "utf8").toString("base64")];
  return out.filter((value) => value.length >= MIN_SECRET_LENGTH);
}

export function createScrubber(): Scrubber {
  const secrets = new Set<string>();
  return {
    add(secret) {
      for (const value of encodings(secret)) secrets.add(value);
    },
    scrub(text) {
      let out = text;
      // Longest first, so a secret that contains another is replaced whole.
      for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
        out = out.split(secret).join(REDACTED);
      }
      return out;
    },
  };
}

/** An error's message, scrubbed and cut to fit a column. */
export function scrubbedMessage(scrubber: Scrubber, error: unknown, max = 2000): string {
  const text = error instanceof Error ? error.message : String(error);
  const clean = scrubber.scrub(text);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * A JSON value with every string scrubbed, keys included. Discovery scrubs
 * what a source offers before it compiles, so the lock, the snapshot rows,
 * and the steering PR are all built from the same scrubbed text.
 */
export function scrubValue<T>(scrubber: Scrubber, value: T): T {
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return scrubber.scrub(item);
    if (Array.isArray(item)) return item.map(walk);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([key, inner]) => [
          scrubber.scrub(key),
          walk(inner),
        ]),
      );
    }
    return item;
  };
  return walk(value) as T;
}
