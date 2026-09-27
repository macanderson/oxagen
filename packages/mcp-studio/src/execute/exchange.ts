// exchange.ts: headers, and the recorded form of an upstream response
// (mcp-studio-spec, Try it and tests).
//
// executeCall returns every exchange it made, so Studio can save the call as
// a test in calls.jsonl. A recorded request is the request as built before the
// credential was added, and each Sender builds it. A recorded response keeps
// every header but Set-Cookie, and its body is the parsed JSON, the text, or
// nothing for an empty body.
import { CREDENTIAL_RESPONSE_HEADERS } from "../contract/tests-files";
import { decodeText, isJsonMediaType, parseJson } from "./body";
import type { HeaderEntry, HttpTransportResponse } from "./transport";

/** The value of a header, in any case. Repeated headers join with a comma, as RFC 9110 allows. */
export function headerValue(headers: readonly HeaderEntry[], name: string): string | undefined {
  const lower = name.toLowerCase();
  const values = headers.filter(([key]) => key.toLowerCase() === lower).map(([, value]) => value);
  return values.length === 0 ? undefined : values.join(", ");
}

const REFUSED_RESPONSE_HEADERS: ReadonlySet<string> = new Set(CREDENTIAL_RESPONSE_HEADERS);

/** The response headers a recording keeps: every one but Set-Cookie, repeats joined. Undefined when none remain. */
export function recordedResponseHeaders(headers: readonly HeaderEntry[]): Record<string, string> | undefined {
  const out = new Map<string, string>();
  for (const [name, value] of headers) {
    if (REFUSED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
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

export function recordHttpResponse(response: HttpTransportResponse, bytes: Uint8Array): RecordedHttpResponse {
  const headers = recordedResponseHeaders(response.headers);
  const body = recordedBody(bytes, headerValue(response.headers, "content-type"));
  return {
    status: response.status,
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
  };
}
