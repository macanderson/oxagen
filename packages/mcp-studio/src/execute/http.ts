// http.ts: the Sender for an OpenAPI operation (mcp-studio-spec, Call path,
// step 5; Retry).
//
// The request comes from the operation's template. Path parameters are
// percent-encoded, query, header, and cookie parameters follow OpenAPI's
// styles, and the body is the spread properties or the one body property. The
// request is recorded before the credential is added. GET, HEAD, OPTIONS,
// PUT, DELETE, and a POST that carries an idempotency key retry on 429, 502,
// 503, and 504, after Retry-After. A transport failure is never retried,
// because the upstream may have acted on the request.
import type { HttpParameter, HttpRequest } from "../model/upstream-tool";
import { placeCredential } from "./apply-credential";
import { decodeText, encodeText, isJsonMediaType, parseJson } from "./body";
import { headerValue } from "./exchange";
import {
  cookieHeader,
  httpTarget,
  parseEndpoint,
  queryPair,
  runHttp,
  sendFailure,
  upstreamError,
  withQuery,
  type HttpExchange,
} from "./http-call";
import { defaultBackoff, type Attempt } from "./retry";
import type { SendContext, Sender, UpstreamArguments } from "./sender";
import type { HeaderEntry, HttpTransportResponse } from "./transport";
import { BuildError, isList, isRecord } from "./util";

export interface HttpSenderOptions {
  /** The wait before retry n when the upstream sent no Retry-After. */
  backoff_ms?: (retry: number) => number;
}

/** Methods RFC 9110 defines as idempotent, so a retry cannot act twice. */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

/**
 * Header parameters the Sender sets itself or that carry a credential. A
 * parameter with one of these names is not sent.
 */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "content-type",
  "content-length",
  "transfer-encoding",
  "connection",
  "host",
  "authorization",
  "proxy-authorization",
  "cookie",
]);

// An RFC 9110 token: the characters a header or cookie name may hold.
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const UNSAFE_HEADER_VALUE = /[\r\n\0]/;
const UNSAFE_COOKIE_VALUE = /[;\r\n\0]/;

function invalidArguments(message: string): BuildError {
  return new BuildError("Invalid arguments", message);
}

function checkedName(parameter: HttpParameter): string {
  if (!TOKEN.test(parameter.name)) {
    throw new BuildError("Invalid request", `The ${parameter.in} parameter name ${parameter.name} is not an HTTP token.`);
  }
  return parameter.name;
}

/** A primitive as the text a request carries. */
function scalarText(value: unknown, name: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "";
  throw invalidArguments(`The parameter ${name} holds a nested value, which its style cannot carry.`);
}

type Shape = { kind: "scalar"; text: string } | { kind: "list"; items: string[] } | { kind: "object"; entries: Array<[string, string]> };

function shapeOf(value: unknown, name: string): Shape {
  if (isList(value)) return { kind: "list", items: value.map((item) => scalarText(item, name)) };
  if (isRecord(value)) {
    return {
      kind: "object",
      entries: Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, scalarText(item, name)]),
    };
  }
  return { kind: "scalar", text: scalarText(value, name) };
}

/** One path parameter, expanded by its style (RFC 6570, as OpenAPI uses it). */
function expandPath(parameter: HttpParameter, value: unknown): string {
  const style = parameter.style ?? "simple";
  const explode = parameter.explode ?? false;
  const shape = shapeOf(value, parameter.name);
  const enc = encodeURIComponent;
  const name = enc(parameter.name);
  switch (style) {
    case "label": {
      if (shape.kind === "scalar") return `.${enc(shape.text)}`;
      if (shape.kind === "list") return `.${shape.items.map(enc).join(explode ? "." : ",")}`;
      return explode
        ? `.${shape.entries.map(([k, v]) => `${enc(k)}=${enc(v)}`).join(".")}`
        : `.${shape.entries.flatMap(([k, v]) => [enc(k), enc(v)]).join(",")}`;
    }
    case "matrix": {
      if (shape.kind === "scalar") return `;${name}=${enc(shape.text)}`;
      if (shape.kind === "list") {
        return explode ? shape.items.map((item) => `;${name}=${enc(item)}`).join("") : `;${name}=${shape.items.map(enc).join(",")}`;
      }
      return explode
        ? shape.entries.map(([k, v]) => `;${enc(k)}=${enc(v)}`).join("")
        : `;${name}=${shape.entries.flatMap(([k, v]) => [enc(k), enc(v)]).join(",")}`;
    }
    case "simple": {
      if (shape.kind === "scalar") return enc(shape.text);
      if (shape.kind === "list") return shape.items.map(enc).join(",");
      return explode
        ? shape.entries.map(([k, v]) => `${enc(k)}=${enc(v)}`).join(",")
        : shape.entries.flatMap(([k, v]) => [enc(k), enc(v)]).join(",");
    }
    default:
      throw new BuildError("Invalid request", `The path parameter ${parameter.name} cannot use the ${style} style.`);
  }
}

/** A header parameter's value: the simple style, sent as written. */
function headerText(parameter: HttpParameter, value: unknown): string {
  const shape = shapeOf(value, parameter.name);
  const text =
    shape.kind === "scalar"
      ? shape.text
      : shape.kind === "list"
        ? shape.items.join(",")
        : parameter.explode === true
          ? shape.entries.map(([k, v]) => `${k}=${v}`).join(",")
          : shape.entries.flat().join(",");
  if (UNSAFE_HEADER_VALUE.test(text)) {
    throw invalidArguments(`The header ${parameter.name} holds a line break or a NUL, so no request can carry it.`);
  }
  return text;
}

/** A cookie parameter's value: the form style without explode, sent as written. */
function cookieText(parameter: HttpParameter, value: unknown): string {
  const shape = shapeOf(value, parameter.name);
  const text = shape.kind === "scalar" ? shape.text : shape.kind === "list" ? shape.items.join(",") : shape.entries.flat().join(",");
  if (UNSAFE_COOKIE_VALUE.test(text)) {
    throw invalidArguments(`The cookie ${parameter.name} holds a semicolon, a line break, or a NUL, so no request can carry it.`);
  }
  return text;
}

/** One query pair: the raw name and value for the recording, and the encoded pair for the target. */
interface QueryEntry {
  name: string;
  value: string;
  encoded: string;
}

function entry(name: string, value: string, encoded = queryPair(name, value)): QueryEntry {
  return { name, value, encoded };
}

/** A query parameter's pairs, by its style. */
function queryEntries(parameter: HttpParameter, value: unknown): QueryEntry[] {
  const style = parameter.style ?? "form";
  const explode = parameter.explode ?? style === "form";
  const shape = shapeOf(value, parameter.name);
  const name = parameter.name;
  const enc = encodeURIComponent;
  if (shape.kind === "scalar") return [entry(name, shape.text)];
  switch (style) {
    case "form":
    case "spaceDelimited":
    case "pipeDelimited": {
      if (shape.kind === "object") {
        if (explode) return shape.entries.map(([k, v]) => entry(k, v));
        const raw = shape.entries.flat().join(",");
        return [entry(name, raw, `${enc(name)}=${shape.entries.flat().map(enc).join(",")}`)];
      }
      if (shape.items.length === 0) return [];
      if (explode) return shape.items.map((item) => entry(name, item));
      const [raw, delimiter] = style === "form" ? [",", ","] : style === "spaceDelimited" ? [" ", "%20"] : ["|", "|"];
      return [entry(name, shape.items.join(raw), `${enc(name)}=${shape.items.map(enc).join(delimiter)}`)];
    }
    case "deepObject": {
      if (shape.kind !== "object") {
        throw invalidArguments(`The query parameter ${name} uses the deepObject style, so it takes an object.`);
      }
      return shape.entries.map(([k, v]) => entry(`${name}[${k}]`, v, `${enc(name)}[${enc(k)}]=${enc(v)}`));
    }
    default:
      throw new BuildError("Invalid request", `The query parameter ${name} cannot use the ${style} style.`);
  }
}

/** The path template with each {name} replaced. A name with no parameter or no value cannot be sent. */
function expandTemplate(template: HttpRequest, args: UpstreamArguments): string {
  const byName = new Map(template.parameters.filter((p) => p.in === "path").map((p) => [p.name, p]));
  return template.path.replace(/\{([^}]*)\}/g, (_match, name: string) => {
    const parameter = byName.get(name);
    if (parameter === undefined) {
      throw new BuildError("Invalid request", `The path ${template.path} names {${name}}, and no path parameter carries it.`);
    }
    const value = args[parameter.property];
    if (value === undefined || value === null) {
      throw invalidArguments(`The path parameter ${name} needs a value from ${parameter.property}.`);
    }
    const expanded = expandPath(parameter, value);
    if (expanded === "") throw invalidArguments(`The path parameter ${name} cannot be empty.`);
    return expanded;
  });
}

interface BuiltBody {
  value: unknown;
  bytes: Uint8Array;
  media_type: string;
}

/** One form value: a string as written, a number, boolean, or null as its JSON text, and an object as JSON. */
function formText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null || typeof value === "object") {
    return JSON.stringify(value);
  }
  throw invalidArguments(`A form body cannot carry a ${typeof value} value.`);
}

function formBody(value: unknown): string {
  if (!isRecord(value)) throw invalidArguments("A form body takes an object.");
  const form = new URLSearchParams();
  for (const [key, item] of Object.entries(value)) {
    // A list repeats the key, once per item.
    const items = (isList(item) ? item : [item]).filter((one) => one !== undefined);
    for (const one of items) form.append(key, formText(one));
  }
  return form.toString();
}

function buildBody(template: HttpRequest, args: UpstreamArguments): BuiltBody | undefined {
  const body = template.body;
  if (body === undefined) return undefined;
  let value: unknown;
  if (body.in === "spread") {
    const present = body.properties.filter((property) => args[property] !== undefined);
    if (present.length === 0 && !body.required) return undefined;
    value = Object.fromEntries(present.map((property) => [property, args[property]]));
  } else {
    value = args[body.property];
    if (value === undefined) {
      if (body.required) throw invalidArguments(`The request body is required, and ${body.property} is missing.`);
      return undefined;
    }
  }
  const media = body.media_type;
  let text: string;
  if (isJsonMediaType(media)) text = JSON.stringify(value);
  else if (media === "application/x-www-form-urlencoded") text = formBody(value);
  else if (media.startsWith("text/")) {
    if (typeof value !== "string") throw invalidArguments(`A ${media} body takes a string.`);
    text = value;
  } else {
    throw new BuildError("Unsupported body", `The gateway cannot send a ${media} body. It sends JSON, form, and text bodies.`);
  }
  return { value, bytes: encodeText(text), media_type: media };
}

function interpret(template: HttpRequest) {
  return (response: HttpTransportResponse, bytes: Uint8Array): Attempt<unknown> => {
    const status = response.status;
    if (status < 200 || status >= 300) return { ok: false, error: upstreamError(response, bytes) };
    if (bytes.byteLength === 0) return { ok: true, value: undefined };
    const contentType = headerValue(response.headers, "content-type") ?? template.response?.media_type;
    const text = decodeText(bytes);
    if (!isJsonMediaType(contentType)) return { ok: true, value: text };
    const parsed = parseJson(text);
    if (!parsed.ok) {
      return {
        ok: false,
        error: { title: "Invalid response", detail: `The upstream answered ${status} with JSON that does not parse: ${parsed.message}`, status },
      };
    }
    const value = template.response?.wrap === "items" && isList(parsed.value) ? { items: parsed.value } : parsed.value;
    return { ok: true, value };
  };
}

/** The request for one call, and how to read and retry it. */
export function buildHttpExchange(
  template: HttpRequest,
  args: UpstreamArguments,
  context: SendContext,
  backoff_ms: (retry: number) => number,
): HttpExchange {
  const endpoint = parseEndpoint(context.environment.url, "base");
  const path = expandTemplate(template, args);
  const idempotencyHeader = context.shaping.idempotency_header;
  const key = context.idempotency_key;
  const idempotency: HeaderEntry | undefined =
    idempotencyHeader === undefined || key === undefined ? undefined : [idempotencyHeader, key];

  const query: QueryEntry[] = [];
  const headerParams: HeaderEntry[] = [];
  const cookies: Array<[string, string]> = [];
  for (const parameter of template.parameters) {
    if (parameter.in === "path") continue;
    const value = args[parameter.property];
    if (value === undefined || value === null) continue;
    if (parameter.in === "query") query.push(...queryEntries(parameter, value));
    else if (parameter.in === "header") {
      const lower = parameter.name.toLowerCase();
      if (RESERVED_HEADERS.has(lower) || lower === idempotencyHeader?.toLowerCase()) continue;
      headerParams.push([checkedName(parameter), headerText(parameter, value)]);
    } else cookies.push([checkedName(parameter), cookieText(parameter, value)]);
  }
  const body = buildBody(template, args);

  const recordedQuery: Record<string, string | string[]> = {};
  for (const { name, value } of query) {
    const earlier = recordedQuery[name];
    recordedQuery[name] = earlier === undefined ? value : [...(typeof earlier === "string" ? [earlier] : earlier), value];
  }
  const recordedHeaders = Object.fromEntries(headerParams);
  const recorded = {
    method: template.method,
    path,
    ...(query.length === 0 ? {} : { query: recordedQuery }),
    ...(headerParams.length === 0 ? {} : { headers: recordedHeaders }),
    ...(body === undefined ? {} : { body: body.value }),
  };

  // The credential is placed after the request is recorded, so no recording holds it.
  const credential = placeCredential(context.auth, context.credential, context.environment.network);
  const pairs = [...query.map((q) => q.encoded), ...credential.query.map(([name, value]) => queryPair(name, value))];
  const target = httpTarget(endpoint, template.method, withQuery(`${endpoint.path}${path}`, pairs));
  const headers: HeaderEntry[] = [
    ...headerParams,
    ["Accept", template.response?.media_type ?? "application/json"],
    ...(body === undefined ? [] : [["Content-Type", body.media_type] as const]),
    ...(idempotency === undefined ? [] : [idempotency]),
    ...cookieHeader([...cookies, ...credential.cookies]),
    ...credential.headers,
  ];
  return {
    context,
    target,
    headers,
    body: body?.bytes ?? new Uint8Array(0),
    relay_credential: credential.relay_credential,
    recorded,
    retryable: IDEMPOTENT_METHODS.has(template.method) || (template.method === "POST" && idempotency !== undefined),
    backoff_ms,
    interpret: interpret(template),
  };
}

/** The Sender for an OpenAPI operation. */
export function createHttpSender(options: HttpSenderOptions = {}): Sender<"http"> {
  const backoff_ms = options.backoff_ms ?? defaultBackoff;
  return {
    kind: "http",
    async send(template, args, context) {
      try {
        return await runHttp(buildHttpExchange(template, args, context, backoff_ms));
      } catch (error) {
        return sendFailure(error, "HTTP");
      }
    },
  };
}
