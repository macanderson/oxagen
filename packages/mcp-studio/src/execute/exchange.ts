// exchange.ts: headers, and the recorded form of an upstream response
// (mcp-studio-spec, Try it and tests).
//
// executeCall returns every exchange it made, so Studio can save the call as
// a test in calls.jsonl. A recorded request is the request as built before the
// credential was added, and each Sender builds it. A recorded response keeps
// every header but Set-Cookie, keeps a Location without its query or fragment,
// and its body is the parsed JSON, the text, or nothing for an empty body or a
// redirect.
import { CREDENTIAL_RESPONSE_HEADERS } from "../contract/tests-files";
import { decodeText, isJsonMediaType, parseJson } from "./body";
import type { HeaderEntry, HttpTransportResponse } from "./transport";

/** The value of a header, in any case. Repeated headers join with a comma, as RFC 9110 allows. */
export function headerValue(headers: readonly HeaderEntry[], name: string): string | undefined {
  const lower = name.toLowerCase();
  const values = headers.filter(([key]) => key.toLowerCase() === lower).map(([, value]) => value);
  return values.length === 0 ? undefined : values.join(", ");
}

/**
 * A Location header's value with no query, fragment, user name, or password.
 *
 * An API key placed in the query can come back in a redirect's Location, and
 * the gateway cannot tell which query values are secrets, so it keeps none of
 * them. An absolute url keeps its scheme, host, port, and path. A relative or
 * unparseable value is cut at its first "?" or "#", and a scheme-relative one
 * ("//host/path") also loses a user name and password. Applying it twice gives
 * the same value as applying it once, so a replayed recording names the same
 * Location as the call it recorded.
 */
export function locationWithoutQuery(location: string): string {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    const cut = location.search(/[?#]/);
    const head = cut === -1 ? location : location.slice(0, cut);
    return head.replace(/^\/\/[^/]*@/, "//");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}

const REFUSED_RESPONSE_HEADERS: ReadonlySet<string> = new Set(CREDENTIAL_RESPONSE_HEADERS);

/**
 * The response headers a recording keeps: every one but Set-Cookie, repeats
 * joined. A Location loses its query and fragment. Undefined when none remain.
 */
export function recordedResponseHeaders(headers: readonly HeaderEntry[]): Record<string, string> | undefined {
  const out = new Map<string, string>();
  for (const [name, raw] of headers) {
    const lower = name.toLowerCase();
    if (REFUSED_RESPONSE_HEADERS.has(lower)) continue;
    const value = lower === "location" ? locationWithoutQuery(raw) : raw;
    const earlier = out.get(name);
    out.set(name, earlier === undefined ? value : `${earlier}, ${value}`);
  }
  return out.size === 0 ? undefined : Object.fromEntries(out);
}

/** A response body as a recording holds it: JSON when it parses as JSON, the text otherwise, and nothing when empty. */
export function recordedBody(bytes: Uint8Array, contentType: string | undefined): unknown {
  if (bytes.byteLength === 0) return undefined;
  const text = decodeText(bytes);
  if (isJsonMediaType(contentType)) {
    const parsed = parseJson(text);
    if (parsed.ok) return parsed.value;
  }
  return text;
}

/** An HTTP response as calls.jsonl records it. Empty keys are left out. */
export interface RecordedHttpResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * The recorded form of a response. A redirect's body is left out: a server
 * often echoes the redirect url in it, query and all, and the error for a 3xx
 * reads only the status and the Location, so a replay gives the same error.
 */
export function recordHttpResponse(response: HttpTransportResponse, bytes: Uint8Array): RecordedHttpResponse {
  const headers = recordedResponseHeaders(response.headers);
  const redirect = response.status >= 300 && response.status < 400;
  const body = redirect ? undefined : recordedBody(bytes, headerValue(response.headers, "content-type"));
  return {
    status: response.status,
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
  };
}
