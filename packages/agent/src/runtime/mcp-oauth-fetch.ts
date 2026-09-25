// The fetch handed to the MCP SDK's OAuth `auth()` and to the registry and
// auth probes (#4132). Every request it makes goes to a host a person or a
// registry record named, so it guards two things a bare `fetch` does not:
//
//   1. **SSRF.** Each URL, including each hop the SDK discovers from
//      well-known metadata, must be a public http(s) address. An
//      authorization server that names `http://169.254.169.254/` as its token
//      endpoint is refused before a byte leaves the process.
//   2. **Time.** An authorization server that accepts the connection and never
//      answers would pin a request for the platform's whole invocation limit,
//      and `auth()` makes several requests in a row. Each one is bounded.
//
// `cache: "no-store"` keeps Next's patched fetch from deduplicating the SDK's
// sequential well-known reads onto one lock.
import { assertPublicHttpUrl } from "@oxagen/config/public-url";

/** Per-request bound for one metadata, registration or token request. */
export const MCP_OAUTH_FETCH_TIMEOUT_MS = 10_000;

/** Redirects followed before the chain is treated as a loop. */
const MAX_REDIRECTS = 5;

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function createMcpOAuthFetch(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = MCP_OAUTH_FETCH_TIMEOUT_MS,
): typeof fetch {
  const guarded = async (
    input: string | URL | Request,
    init?: RequestInit,
    hops = 0,
  ): Promise<Response> => {
    if (hops > MAX_REDIRECTS) {
      throw new Error(
        "Refusing an MCP authorization request: too many redirects",
      );
    }
    assertPublicHttpUrl(urlOf(input), {
      refusing: "Refusing an MCP authorization request",
    });
    // fetch follows redirects by default; this follows them itself, so a hop
    // to a private address meets the guard above rather than bypassing it.
    const follow = (init?.redirect ?? "follow") === "follow";
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    return fetchImpl(input, {
      ...init,
      cache: "no-store",
      redirect: follow ? "manual" : init?.redirect,
      signal,
    }).then(async (response) => {
      if (
        follow &&
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.get("location") !== null
      ) {
        const next = new URL(
          response.headers.get("location") ?? "",
          urlOf(input),
        ).toString();
        await response.body?.cancel().catch(() => undefined);
        return guarded(next, { ...init, redirect: "follow" }, hops + 1);
      }
      return response;
    });
  };
  return ((input: string | URL | Request, init?: RequestInit) =>
    guarded(input, init)) as typeof fetch;
}

export const mcpOAuthFetch = createMcpOAuthFetch();
