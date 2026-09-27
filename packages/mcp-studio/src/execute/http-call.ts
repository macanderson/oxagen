// http-call.ts: the parts of an HTTP send the HTTP, GraphQL, and MCP Senders
// share (mcp-studio-spec, Call path, Send and Retry; Host rules).
//
// The environment's url gives the scheme, host, port, and base path. The
// target the Transport receives is exactly a relay envelope's http target,
// so it is checked against that schema before anything is sent. One attempt
// sends the request inside the call's deadline, reads the body under the
// size cap, and records the exchange. A kind's own interpret step turns the
// response into a value or an error, and this module adds the retry rule.
import { hostSchema, type HttpMethod } from "../contract/primitives";
import { relayHttpTargetSchema } from "../contract/relay-envelope";
import type { RecordedExchange } from "../contract/tests-files";
import { decodeText, isJsonMediaType, parseJson, readBody, transportFailure } from "./body";
import type { RelayCredential } from "./credentials";
import { headerValue, recordHttpResponse } from "./exchange";
import { Clock, retryAfterMs, stopError, withRetries, type Attempt } from "./retry";
import type { SendContext, SendError, SendResult } from "./sender";
import type { HeaderEntry, HttpTarget, HttpTransportResponse } from "./transport";
import { BuildError, isRecord, messageOf } from "./util";

/** The scheme, host, port, and path an environment's url gives. */
export interface Endpoint {
  scheme: "https" | "http";
  host: string;
  /** Undefined for the scheme's default port, as a relay envelope writes it. */
  port: number | undefined;
  /** For a base url, the path with no trailing slash, or "" for none. For an endpoint, the path and query. */
  path: string;
}

function invalidEnvironment(detail: string): BuildError {
  return new BuildError("Invalid environment", detail);
}

/**
 * Read an environment's url.
 *
 * - base: an OpenAPI server url. Operation paths go after its path, so a
 *   trailing slash is dropped, and it may not carry a query.
 * - endpoint: an MCP or GraphQL endpoint, sent to exactly as written.
 */
export function parseEndpoint(url: string | undefined, use: "base" | "endpoint"): Endpoint {
  if (url === undefined) throw invalidEnvironment("The environment has no url, so the call has no host.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidEnvironment(`The environment url ${url} does not parse.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw invalidEnvironment(`An environment url is https or http, not ${parsed.protocol.slice(0, -1)}.`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw invalidEnvironment("An environment url cannot carry a user name or password. Store the secret as a credential.");
  }
  if (parsed.hash !== "") throw invalidEnvironment(`An environment url has no fragment: ${url}.`);
  if (parsed.hostname.startsWith("[")) {
    throw invalidEnvironment("An IPv6 host is not supported. Name the host, or use an IPv4 address.");
  }
  const host = parsed.hostname.toLowerCase();
  if (!hostSchema.safeParse(host).success) throw invalidEnvironment(`${host} is not a host name or an IPv4 address.`);
  if (use === "base" && parsed.search !== "") {
    throw invalidEnvironment(`An API's base url has no query: ${url}.`);
  }
  return {
    scheme: parsed.protocol === "https:" ? "https" : "http",
    host,
    // URL drops the scheme's default port, which is how the envelope writes it.
    port: parsed.port === "" ? undefined : Number(parsed.port),
    path: use === "base" ? parsed.pathname.replace(/\/+$/, "") : parsed.pathname + parsed.search,
  };
}

/** path with each query pair added. Each pair is already percent-encoded as name=value. */
export function withQuery(path: string, pairs: readonly string[]): string {
  if (pairs.length === 0) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${pairs.join("&")}`;
}

/** One query pair, percent-encoded. */
export function queryPair(name: string, value: string): string {
  return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
}

/** The target for one request, checked against the relay envelope's schema. */
export function httpTarget(endpoint: Endpoint, method: HttpMethod, path: string): HttpTarget {
  const target = relayHttpTargetSchema.safeParse({
    kind: "http",
    scheme: endpoint.scheme,
    method,
    host: endpoint.host,
    port: endpoint.port,
    path,
  });
  if (!target.success) {
    const issue = target.error.issues[0];
    const detail = issue === undefined ? target.error.message : `${issue.path.join(".")}: ${issue.message}`;
    throw new BuildError("Invalid request", `The request target is not valid (${detail}).`);
  }
  return target.data;
}

/** The Cookie header for a list of cookies, or none. */
export function cookieHeader(cookies: ReadonlyArray<readonly [string, string]>): HeaderEntry[] {
  if (cookies.length === 0) return [];
  return [["Cookie", cookies.map(([name, value]) => `${name}=${value}`).join("; ")]];
}

/** The statuses a retryable request retries on. */
export const RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

const MAX_DETAIL = 1000;

/** An upstream's text for an error detail: trimmed, and cut at 1000 characters. */
export function cutDetail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_DETAIL ? trimmed : `${trimmed.slice(0, MAX_DETAIL)}…`;
}

function firstText(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const text = value[key];
    if (typeof text === "string" && text.trim() !== "") return text;
  }
  return undefined;
}

/**
 * The error for a response that is not a success. A redirect names its
 * Location, because the gateway never follows one. Any other status takes the
 * RFC 9457 title and detail when the upstream sent them.
 */
export function upstreamError(response: HttpTransportResponse, bytes: Uint8Array): SendError {
  const status = response.status;
  if (status >= 300 && status < 400) {
    const location = headerValue(response.headers, "location");
    return {
      title: "Redirect not followed",
      detail:
        `The upstream answered ${status}${location === undefined ? "" : ` with Location ${location}`}. ` +
        "The gateway does not follow redirects, so set the environment's url to the final address.",
      status,
    };
  }
  const text = bytes.byteLength === 0 ? "" : decodeText(bytes);
  let problem: Record<string, unknown> | undefined;
  if (text !== "" && isJsonMediaType(headerValue(response.headers, "content-type"))) {
    const parsed = parseJson(text);
    if (parsed.ok && isRecord(parsed.value)) problem = parsed.value;
  }
  const title = problem === undefined ? undefined : firstText(problem, ["title"]);
  const detail =
    problem === undefined
      ? text.trim() === ""
        ? undefined
        : text
      : firstText(problem, ["detail", "message", "error_description", "error"]);
  return {
    title: title === undefined ? "Upstream error" : cutDetail(title),
    detail: detail === undefined ? `The upstream answered ${status}.` : cutDetail(detail),
    status,
  };
}

/**
 * The result for a send that failed before or outside any attempt. A request
 * that cannot be built keeps its BuildError title. Anything else is a defect
 * in the Sender, named as one.
 */
export function sendFailure(error: unknown, sender: string): SendResult {
  if (error instanceof BuildError) {
    return { ok: false, error: { title: error.title, detail: error.message, status: undefined }, attempts: 0 };
  }
  return {
    ok: false,
    error: { title: "Internal error", detail: `The ${sender} Sender failed: ${messageOf(error)}`, status: undefined },
    attempts: 0,
  };
}

/** Turn a synchronous throw into a rejection, so a Transport that throws fails like one that rejects. */
export function settle<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(run());
  });
}

type RecordedRequest = RecordedExchange["request"];

/** One HTTP request, ready to send, and how to read its response. */
export interface HttpExchange {
  context: SendContext;
  target: HttpTarget;
  headers: HeaderEntry[];
  body: Uint8Array;
  relay_credential: RelayCredential | undefined;
  /** The request as built before the credential was added. */
  recorded: RecordedRequest;
  /** Whether a 429, 502, 503, or 504 may be retried. */
  retryable: boolean;
  backoff_ms: (retry: number) => number;
  /** The value or the error for a response, whatever its status. */
  interpret: (response: HttpTransportResponse, bytes: Uint8Array) => Attempt<unknown>;
}

interface Outcome {
  attempt: Attempt<unknown>;
  exchange: RecordedExchange | undefined;
}

async function attemptOnce(spec: HttpExchange, deadline: number): Promise<Outcome> {
  const { context } = spec;
  const deadline_ms = context.shaping.deadline_ms;
  const controller = new AbortController();
  const clock = new Clock(deadline, context.signal, controller);
  try {
    const pending = settle(() =>
      context.transport.http({
        network: context.environment.network,
        deadline_ms: Math.max(1, deadline - Date.now()),
        signal: controller.signal,
        relay_credential: spec.relay_credential,
        target: spec.target,
        headers: spec.headers,
        body: spec.body,
      }),
    );
    const sent = await clock.race(pending);
    if (sent.kind === "stopped") {
      // A response that arrives after the stop is released unread.
      pending.then(
        (late) => late.cancel(),
        () => undefined,
      );
      return { attempt: { ok: false, error: stopError(sent.stop, deadline_ms) }, exchange: undefined };
    }
    if (sent.kind === "failed") {
      return { attempt: { ok: false, error: transportFailure(sent.error).error }, exchange: undefined };
    }
    const response = sent.value;
    const read = await readBody(response, { clock, deadline_ms });
    if (!read.ok) return { attempt: read, exchange: undefined };
    const exchange: RecordedExchange = { request: spec.recorded, response: recordHttpResponse(response, read.bytes) };
    const attempt = spec.interpret(response, read.bytes);
    if (!attempt.ok && spec.retryable && RETRY_STATUSES.has(response.status)) {
      const after_ms = retryAfterMs(headerValue(response.headers, "retry-after"), Date.now());
      return { attempt: { ok: false, error: attempt.error, retry: { after_ms } }, exchange };
    }
    return { attempt, exchange };
  } finally {
    clock.dispose();
  }
}

/**
 * Send one request with its kind's retry rule. The result carries the final
 * attempt's exchange, when a response arrived.
 */
export async function runHttp(spec: HttpExchange): Promise<SendResult> {
  const deadline = Date.now() + spec.context.shaping.deadline_ms;
  let exchange: RecordedExchange | undefined;
  const result = await withRetries(
    async () => {
      const outcome = await attemptOnce(spec, deadline);
      exchange = outcome.exchange;
      return outcome.attempt;
    },
    { deadline, signal: spec.context.signal, backoff_ms: spec.backoff_ms },
  );
  const exchanges = exchange === undefined ? [] : [exchange];
  return result.ok
    ? { ok: true, value: result.value, attempts: result.attempts, exchanges }
    : { ok: false, error: result.error, attempts: result.attempts, exchanges };
}
