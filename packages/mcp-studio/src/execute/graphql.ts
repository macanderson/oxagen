// graphql.ts: the Sender for a GraphQL root field (mcp-studio-spec, Call path,
// step 5; Retry).
//
// One call is one POST. The document names the root field once, declares a
// variable for each argument the call carries, and adds the selection set.
// The arguments travel as variables, never inside the document, so no value
// needs escaping. A response with a non-empty errors array is an error even
// when its status is 200. A query retries as GET does, on 429, 502, 503, and
// 504. A mutation never retries, because the upstream may have acted on it.
import type { GraphqlRequest } from "../model/upstream-tool";
import { placeCredential } from "./apply-credential";
import { decodeText, encodeText, parseJson } from "./body";
import {
  cookieHeader,
  cutDetail,
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
import { isList, isRecord } from "./util";

export interface GraphqlSenderOptions {
  /** The wait before retry n when the upstream sent no Retry-After. */
  backoff_ms?: (retry: number) => number;
}

/** The POST body: the document, and the variables when the call carries any. */
export interface GraphqlDocument {
  query: string;
  variables?: Record<string, unknown>;
}

/** The field name in "Root.field". */
function fieldName(field: string): string {
  return field.slice(field.indexOf(".") + 1);
}

/** A selection set in braces. tools.toml may write the fields without them. */
function selectionSet(selection: string | undefined): string {
  if (selection === undefined) return "";
  const trimmed = selection.trim();
  return trimmed.startsWith("{") ? ` ${trimmed}` : ` { ${trimmed} }`;
}

/**
 * The document and variables for one call. An argument is declared and
 * passed only when the call carries it. A null is passed, because GraphQL
 * reads an explicit null differently from an absent argument.
 */
export function graphqlDocument(template: GraphqlRequest, args: UpstreamArguments): GraphqlDocument {
  const field = fieldName(template.field);
  const present = template.arguments.filter((argument) => args[argument.property] !== undefined);
  const declared = present.length === 0 ? "" : `(${present.map((a) => `$${a.name}: ${a.type}`).join(", ")})`;
  const passed = present.length === 0 ? "" : `(${present.map((a) => `${a.name}: $${a.name}`).join(", ")})`;
  const operation = `${field.charAt(0).toUpperCase()}${field.slice(1)}`;
  const query = `${template.operation_type} ${operation}${declared} { ${field}${passed}${selectionSet(template.selection)} }`;
  if (present.length === 0) return { query };
  return { query, variables: Object.fromEntries(present.map((a) => [a.name, args[a.property]])) };
}

/** The messages of a GraphQL errors array, joined. An entry with no message is shown as JSON. */
function errorMessages(errors: readonly unknown[]): string {
  return errors
    .map((entry) => (isRecord(entry) && typeof entry.message === "string" ? entry.message : JSON.stringify(entry)))
    .join("; ");
}

function invalidResponse(detail: string, status: number): Attempt<unknown> {
  return { ok: false, error: { title: "Invalid response", detail, status } };
}

function interpret(template: GraphqlRequest) {
  const field = fieldName(template.field);
  return (response: HttpTransportResponse, bytes: Uint8Array): Attempt<unknown> => {
    const status = response.status;
    // A GraphQL server may answer with any content type, so the body is read as JSON whatever it says.
    const parsed = bytes.byteLength === 0 ? undefined : parseJson(decodeText(bytes));
    const body = parsed?.ok === true ? parsed.value : undefined;
    if (isRecord(body) && isList(body.errors) && body.errors.length > 0) {
      return { ok: false, error: { title: "GraphQL error", detail: cutDetail(errorMessages(body.errors)), status } };
    }
    if (status < 200 || status >= 300) return { ok: false, error: upstreamError(response, bytes) };
    if (parsed === undefined) return invalidResponse(`The upstream answered ${status} with no body.`, status);
    if (!parsed.ok) return invalidResponse(`The upstream answered ${status} with JSON that does not parse: ${parsed.message}`, status);
    const data = isRecord(body) ? body.data : undefined;
    if (!isRecord(data)) return invalidResponse(`The upstream answered ${status} with no data object.`, status);
    if (!Object.hasOwn(data, field)) return invalidResponse(`The response's data has no ${field} field.`, status);
    const value = data[field];
    return { ok: true, value: isList(value) ? { items: value } : value };
  };
}

/** The request for one call, and how to read and retry it. */
export function buildGraphqlExchange(
  template: GraphqlRequest,
  args: UpstreamArguments,
  context: SendContext,
  backoff_ms: (retry: number) => number,
): HttpExchange {
  const endpoint = parseEndpoint(context.environment.url, "endpoint");
  const document = graphqlDocument(template, args);
  const idempotencyHeader = context.shaping.idempotency_header;
  const key = context.idempotency_key;
  const idempotency: HeaderEntry | undefined =
    idempotencyHeader === undefined || key === undefined ? undefined : [idempotencyHeader, key];

  // The credential is placed after the request is recorded, so no recording holds it.
  const credential = placeCredential(context.auth, context.credential, context.environment.network);
  const pairs = credential.query.map(([name, value]) => queryPair(name, value));
  const target = httpTarget(endpoint, "POST", withQuery(endpoint.path, pairs));
  const headers: HeaderEntry[] = [
    ["Accept", "application/graphql-response+json, application/json"],
    ["Content-Type", "application/json"],
    ...(idempotency === undefined ? [] : [idempotency]),
    ...cookieHeader(credential.cookies),
    ...credential.headers,
  ];
  return {
    context,
    target,
    headers,
    body: encodeText(JSON.stringify(document)),
    relay_credential: credential.relay_credential,
    recorded: document,
    retryable: template.operation_type === "query",
    backoff_ms,
    interpret: interpret(template),
  };
}

/** The Sender for a GraphQL root field. */
export function createGraphqlSender(options: GraphqlSenderOptions = {}): Sender<"graphql"> {
  const backoff_ms = options.backoff_ms ?? defaultBackoff;
  return {
    kind: "graphql",
    async send(template, args, context) {
      try {
        return await runHttp(buildGraphqlExchange(template, args, context, backoff_ms));
      } catch (error) {
        return sendFailure(error, "GraphQL");
      }
    },
  };
}
