// The CLI's loopback redirect target (RFC 8252 §7.3, ARCHITECTURE.md §3.8). A
// LoopbackUri is a plain-http URL on 127.0.0.1 or [::1] with an explicit port,
// no credentials, no query and no fragment, written exactly as the URL parser
// writes it back, so a path with dot segments, a backslash or any other form
// the parser rewrites is refused rather than normalised into an accepted one.
// It is the only place a CLI authorization code may be sent.

declare const loopbackUri: unique symbol;
export type LoopbackUri = string & { readonly [loopbackUri]: true };

const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "[::1]"];

function isLoopbackUri(raw: string, url: URL): raw is LoopbackUri {
  return (
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.includes(url.hostname) &&
    Number(url.port) >= 1 &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.href === raw
  );
}

export function parseLoopbackUri(raw: string): LoopbackUri | null {
  if (!URL.canParse(raw)) return null;
  return isLoopbackUri(raw, new URL(raw)) ? raw : null;
}
