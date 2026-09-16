/**
 * The loopback listener's browser guard (ADR-069).
 *
 * Until the MCP gateway, the collector's TCP listener was reached by two
 * things we installed ourselves: Claude Code's `http` hooks and its OTLP
 * exporter. The gateway makes it a port any MCP client on the machine
 * connects to, which means it is worth attacking, and the attack that matters
 * is not a local process — a local process with the user's privileges can read
 * `host.json` and have the bearer anyway. It is **DNS rebinding**.
 *
 * The shape: the user opens a page on `evil.example`. That name resolves, on
 * the second lookup, to `127.0.0.1`. The page then fetches
 * `http://evil.example:<port>/status`. The browser believes it is talking to
 * `evil.example`, so its same-origin policy permits the read, but the packets
 * arrive at our listener. The bearer alone does not stop this: any token that
 * has leaked into a place a page can read (a settings file rendered into a
 * local web app, a log, an extension) is enough, and the request is a
 * same-origin one from the browser's point of view, so nothing else objects.
 *
 * Two headers close it, and both are checked on **every** request, not only on
 * `/mcp`:
 *
 *   - `Host` must name a loopback address. A rebound request carries the
 *     attacker's hostname, because that is what the page asked for.
 *   - `Origin`, when present, must be a loopback origin. A browser sets it on
 *     every cross-origin request and on every non-GET; a native MCP client
 *     sends none, which is why absence is allowed rather than required.
 *
 * Neither check replaces the bearer. Both run before it, because a request
 * that should never have reached us is not worth a constant-time compare.
 */

/** Host names that mean "this machine" and nothing else. */
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Split a `Host` or an origin's authority into name and port. IPv6 literals
 * keep their brackets, which is how they appear in both headers.
 */
function splitAuthority(authority: string): { name: string; port?: string } {
  const trimmed = authority.trim();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close === -1) return { name: trimmed };
    const name = trimmed.slice(0, close + 1);
    const rest = trimmed.slice(close + 1);
    return rest.startsWith(":") ? { name, port: rest.slice(1) } : { name };
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon === -1) return { name: trimmed };
  return { name: trimmed.slice(0, colon), port: trimmed.slice(colon + 1) };
}

function isLoopbackName(name: string): boolean {
  const lower = name.toLowerCase();
  if (LOOPBACK_NAMES.has(lower)) return true;
  // The whole 127.0.0.0/8 block is loopback, and a client may dial any of it.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower);
}

/**
 * Whether a `Host` header names this listener. A request with no `Host` is
 * refused: HTTP/1.1 requires one, and the only callers that omit it are
 * hand-rolled.
 *
 * The port must match ours when the header carries one. A `Host` naming a
 * loopback address on a *different* port is not for us, and honouring it would
 * let a page that has guessed one port reach another.
 */
export function isAllowedHostHeader(
  host: string | undefined,
  port: number | undefined,
): boolean {
  if (typeof host !== "string" || host.length === 0) return false;
  const { name, port: headerPort } = splitAuthority(host);
  if (!isLoopbackName(name)) return false;
  if (headerPort === undefined) return true;
  if (!/^\d+$/.test(headerPort)) return false;
  // A listener that does not know its own port (the Unix socket) takes any
  // loopback port: there is no port to disagree with.
  return port === undefined || Number(headerPort) === port;
}

/**
 * Whether an `Origin` header may reach us. Absent is allowed — native clients
 * send none. Present means a browser, or something imitating one, and only a
 * loopback origin is accepted.
 *
 * `"null"` is refused explicitly: a sandboxed iframe, a `data:` document and a
 * cross-origin redirect all produce it, and none of them is a client of ours.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin.length === 0) return true;
  if (origin === "null") return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return isLoopbackName(url.hostname);
}

export interface GuardVerdict {
  ok: boolean;
  /** Why it was refused, for the log and the 403 body. */
  reason?: "host" | "origin";
}

/**
 * The whole guard, as one call. Returns the reason so the daemon's log names
 * which header failed — a rebinding attempt and a misconfigured client look
 * identical in a 403 with no detail.
 */
export function guardLoopbackRequest(
  headers: { host?: string | undefined; origin?: string | undefined },
  port: number | undefined,
): GuardVerdict {
  if (!isAllowedHostHeader(headers.host, port))
    return { ok: false, reason: "host" };
  if (!isAllowedOrigin(headers.origin)) return { ok: false, reason: "origin" };
  return { ok: true };
}

/** What a refused request is told. Deliberately says why: it is not a secret. */
export const GUARD_MESSAGES: Record<"host" | "origin", string> = {
  host: "this listener answers only to a loopback Host header",
  origin: "this listener refuses cross-origin browser callers",
};
